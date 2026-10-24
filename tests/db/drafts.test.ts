import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiDrafts, auditLogs, citations, tenants, ticketMessages, user } from "@/db/schema";
import { logger } from "@/lib/logger";
import {
  fallbackReply,
  generateDraft,
  getLatestDraft,
  listPendingDrafts,
  reviewDraft,
} from "@/server/ai/drafts";
import { addDocument } from "@/server/knowledge/documents";
import { createTicket, getTicket } from "@/server/tickets";
import { mockDraftModel, mockEmbedder } from "../ai/mock-knowledge";
import { createTestDb, type TestDb } from "./test-db";

/* Draft replies end to end on PGlite, with a MOCK embedder and draft model (no network). */

let db: TestDb;
let close: () => Promise<void>;
let tenantA: string;
let tenantB: string;
const log = logger.child({ test: "drafts" });
const actor = { type: "api_key" as const, apiKeyId: "00000000-0000-4000-8000-000000000001" };
const agent = { id: "agent_a", name: "Sam Agent" };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const [a, b] = await db
    .insert(tenants)
    .values([
      { slug: "tenant-a", name: "Tenant A" },
      { slug: "tenant-b", name: "Tenant B" },
    ])
    .returning();
  tenantA = a.id;
  tenantB = b.id;
  await db.insert(user).values([
    { id: "agent_a", tenantId: tenantA, name: "Sam Agent", email: "agent@a.test", role: "agent" },
    { id: "agent_b", tenantId: tenantB, name: "Bo Agent", email: "agent@b.test", role: "agent" },
  ]);
  const add = (kind: "article" | "runbook", name: string, text: string) =>
    addDocument(
      db,
      {
        tenantId: tenantA,
        uploadedById: null,
        kind,
        file: { filename: name, mimeType: "text/markdown", sizeBytes: text.length, text },
      },
      { embedPassages: mockEmbedder.embedPassages, log },
    );
  await add(
    "article",
    "refunds.md",
    "# Refunds\n\n## Duplicate charges\n\nIf you were charged twice, open Billing, select the duplicate invoice and click Refund. The money reaches your card in 5 to 7 business days.",
  );
  await add(
    "runbook",
    "internal.md",
    "# Duplicate charge runbook\n\nInternal: duplicate charges above 500 need finance approval code RB-SECRET.",
  );
});

afterAll(async () => {
  await close?.();
});

async function ticket(
  body = "I was charged twice this month, please refund the duplicate charge. Email priya@example.test",
  tenantId = tenantA,
) {
  return createTicket(
    db,
    tenantId,
    {
      subject: "Charged twice",
      body,
      customer: { name: "Priya Nair", email: "priya@example.test" },
    },
    { actor, source: "api" },
  );
}

const deps = (model = mockDraftModel()) => ({ embedQuery: mockEmbedder.embedQuery, model, log });

describe("generateDraft", () => {
  it("drafts from help articles only, redacts PII, and saves citations and an audit row", async () => {
    const t = await ticket();
    const model = mockDraftModel();
    const { draftId, grounded } = await generateDraft(
      db,
      { tenantId: tenantA, ticketId: t.id, userId: "agent_a" },
      deps(model),
    );

    expect(grounded).toBe(true);
    const sent = model.messages[0];
    expect(sent).toContain("<customer>Priya</customer>");
    expect(sent).toContain('<source n="1" title="Refunds">');
    expect(sent).not.toContain("RB-SECRET"); // internal runbooks never reach a customer draft
    expect(sent).not.toContain("priya@example.test");

    const draft = await getLatestDraft(db, tenantA, t.id);
    expect(draft).toMatchObject({
      id: draftId,
      status: "pending",
      groundingStatus: "grounded",
      requestedById: "agent_a",
      model: "mock-draft-model",
      inputTokens: 2500,
      outputTokens: 180,
      latencyMs: 70,
    });
    expect(draft!.sources).toMatchObject([{ position: 1, documentTitle: "Refunds" }]);
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, t.id), eq(auditLogs.action, "draft.generated")));
    expect(audit.metadata).toMatchObject({ draftId, grounded: true });
  });

  it("falls back to a holding reply when the model can't cite the articles", async () => {
    const t = await ticket();
    for (const output of [
      { status: "insufficient_evidence" as const },
      { reply: "We will refund you 100% today.", cited_sources: [] },
      { reply: "Refund issued [7].", cited_sources: [7] },
    ]) {
      const { grounded } = await generateDraft(
        db,
        { tenantId: tenantA, ticketId: t.id, userId: "agent_a" },
        deps(mockDraftModel(output)),
      );
      const draft = await getLatestDraft(db, tenantA, t.id);
      expect(grounded).toBe(false);
      expect(draft).toMatchObject({
        body: fallbackReply("Priya Nair"),
        groundingStatus: "insufficient_evidence",
      });
      expect(draft!.sources).toEqual([]);
    }
  });

  it("uses the holding reply without calling the model when no article matches", async () => {
    const t = await createTicket(
      db,
      tenantA,
      {
        subject: "Qwerty",
        body: "zzzz qqqq xxxx",
        customer: { name: "Priya", email: "p@example.test" },
      },
      { actor, source: "api" },
    );
    const model = mockDraftModel();
    const result = await generateDraft(
      db,
      { tenantId: tenantA, ticketId: t.id, userId: "agent_a" },
      { embedQuery: null, model, log },
    );
    expect(result.grounded).toBe(false);
    expect(model.messages).toHaveLength(0);
    expect((await getLatestDraft(db, tenantA, t.id))!.model).toBe("none");
  });

  it("supersedes the ticket's earlier pending draft", async () => {
    const t = await ticket();
    const first = await generateDraft(
      db,
      { tenantId: tenantA, ticketId: t.id, userId: "agent_a" },
      deps(),
    );
    const second = await generateDraft(
      db,
      { tenantId: tenantA, ticketId: t.id, userId: "agent_a" },
      deps(),
    );
    const [old] = await db.select().from(aiDrafts).where(eq(aiDrafts.id, first.draftId));
    expect(old).toMatchObject({ status: "rejected", rejectReason: "Superseded by a newer draft" });
    expect((await listPendingDrafts(db, tenantA)).map((d) => d.draftId)).toContain(second.draftId);
    expect((await listPendingDrafts(db, tenantA)).map((d) => d.draftId)).not.toContain(
      first.draftId,
    );
  });

  it("won't draft for another tenant's ticket", async () => {
    const t = await ticket(undefined, tenantB);
    await expect(
      generateDraft(db, { tenantId: tenantA, ticketId: t.id, userId: "agent_a" }, deps()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("reviewDraft", () => {
  async function pendingDraft() {
    const t = await ticket();
    const { draftId } = await generateDraft(
      db,
      { tenantId: tenantA, ticketId: t.id, userId: "agent_a" },
      deps(),
    );
    return { ticketId: t.id, draftId };
  }

  it("approving adds the reply without citation markers, signs it, and updates the ticket", async () => {
    const { ticketId, draftId } = await pendingDraft();
    const draft = await getLatestDraft(db, tenantA, ticketId);
    const result = await reviewDraft(
      db,
      { tenantId: tenantA, reviewer: agent },
      { decision: "approve", draftId, body: draft!.body },
    );
    expect(result.status).toBe("approved");

    const [msg] = await db
      .select()
      .from(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, ticketId), eq(ticketMessages.authorType, "agent")));
    expect(msg).toMatchObject({ authorId: "agent_a", sourceDraftId: draftId });
    expect(msg.body).not.toMatch(/\[\d+\]/);
    expect(msg.body).toContain("click Refund. It reaches");
    expect(msg.body.endsWith("Best regards,\nSam Agent")).toBe(true);

    const t = await getTicket(db, tenantA, ticketId);
    expect(t.status).toBe("pending");
    expect(t.firstResponseAt).toBeInstanceOf(Date);
    const [row] = await db.select().from(aiDrafts).where(eq(aiDrafts.id, draftId));
    expect(row).toMatchObject({ status: "approved", reviewedById: "agent_a", finalBody: msg.body });
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, ticketId), eq(auditLogs.action, "draft.approved")));
    expect(audit.actorId).toBe("agent_a");
  });

  it("records an edited approval, and refuses to approve twice", async () => {
    const { draftId } = await pendingDraft();
    const result = await reviewDraft(
      db,
      { tenantId: tenantA, reviewer: agent },
      {
        decision: "approve",
        draftId,
        body: "Hi Priya,\n\nI've refunded the duplicate charge.\n\nBest regards,",
      },
    );
    expect(result.status).toBe("edited");
    await expect(
      reviewDraft(
        db,
        { tenantId: tenantA, reviewer: agent },
        { decision: "approve", draftId, body: "again" },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejecting records the reason and adds nothing to the conversation", async () => {
    const { ticketId, draftId } = await pendingDraft();
    await reviewDraft(
      db,
      { tenantId: tenantA, reviewer: agent },
      { decision: "reject", draftId, reason: "Wrong article" },
    );
    const [row] = await db.select().from(aiDrafts).where(eq(aiDrafts.id, draftId));
    expect(row).toMatchObject({
      status: "rejected",
      rejectReason: "Wrong article",
      finalBody: null,
    });
    const agentMessages = await db
      .select()
      .from(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, ticketId), eq(ticketMessages.authorType, "agent")));
    expect(agentMessages).toHaveLength(0);
  });

  it("can't review another tenant's draft", async () => {
    const { draftId } = await pendingDraft();
    await expect(
      reviewDraft(
        db,
        { tenantId: tenantB, reviewer: { id: "agent_b", name: "Bo" } },
        { decision: "reject", draftId },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await listPendingDrafts(db, tenantB)).toEqual([]);
  });

  it("keeps citation rows linked to the draft", async () => {
    const { draftId } = await pendingDraft();
    const rows = await db.select().from(citations).where(eq(citations.draftId, draftId));
    expect(rows.length).toBeGreaterThan(0);
  });
});
