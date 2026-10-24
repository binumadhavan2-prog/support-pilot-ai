import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditLogs,
  citations,
  documentChunks,
  documents,
  kbQueries,
  tenants,
  user,
} from "@/db/schema";
import { logger } from "@/lib/logger";
import { NO_SOURCES_ANSWER, askKnowledgeBase } from "@/server/ai/answer";
import {
  addDocument,
  deleteDocument,
  indexDocument,
  listDocuments,
} from "@/server/knowledge/documents";
import { searchKnowledge } from "@/server/knowledge/search";
import { mockAnswerModel, mockEmbedder } from "../ai/mock-knowledge";
import { createTestDb, type TestDb } from "./test-db";

/* Knowledge base on PGlite (real pgvector + full-text search) with MOCK embedder and model. */

let db: TestDb;
let close: () => Promise<void>;
let tenantA: string;
let tenantB: string;
const log = logger.child({ test: "knowledge" });
const deps = { embedPassages: mockEmbedder.embedPassages, log };

const REFUNDS = `# Refunds

## Duplicate charges

If a customer was charged twice, open the Billing page, select the duplicate invoice and click
Refund. The refund reaches the card in 5 to 7 business days.

## Annual plans

Annual plans can be refunded within 30 days of purchase.`;

const SSO = `# Single sign-on

## Setting up SAML

Admins can enable SAML single sign-on under Settings > Security. Upload the identity provider
metadata XML and map the email attribute.`;

function file(text: string, filename = "doc.md") {
  return { filename, mimeType: "text/markdown", sizeBytes: Buffer.byteLength(text), text };
}

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
    { id: "admin_a", tenantId: tenantA, name: "Admin A", email: "admin@a.test", role: "admin" },
    { id: "agent_a", tenantId: tenantA, name: "Agent A", email: "agent@a.test", role: "agent" },
    { id: "admin_b", tenantId: tenantB, name: "Admin B", email: "admin@b.test", role: "admin" },
  ]);
  for (const [text, name] of [
    [REFUNDS, "refunds.md"],
    [SSO, "sso.md"],
  ]) {
    await addDocument(
      db,
      { tenantId: tenantA, uploadedById: "admin_a", kind: "article", file: file(text, name) },
      deps,
    );
  }
  await addDocument(
    db,
    {
      tenantId: tenantB,
      uploadedById: "admin_b",
      kind: "article",
      file: file("# Tenant B secret\n\nRefund codes for tenant B: duplicate charge override 4242."),
    },
    deps,
  );
});

afterAll(async () => {
  await close?.();
});

describe("addDocument", () => {
  it("stores the document, its sections with embeddings, and an audit row", async () => {
    const [doc] = (await listDocuments(db, tenantA)).filter((d) => d.title === "Refunds");
    expect(doc).toMatchObject({
      kind: "article",
      status: "ready",
      errorMessage: null,
      isDemo: false,
    });
    expect(doc.chunkCount).toBeGreaterThanOrEqual(2);

    const chunks = await db
      .select()
      .from(documentChunks)
      .where(eq(documentChunks.documentId, doc.id));
    expect(chunks).toHaveLength(doc.chunkCount);
    expect(chunks.every((c) => c.embedding !== null)).toBe(true);
    expect(chunks.some((c) => c.content.startsWith("Refunds > Duplicate charges"))).toBe(true);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, doc.id), eq(auditLogs.action, "document.uploaded")));
    expect(audit.actorId).toBe("admin_a");
  });

  it("rejects the same file twice in a tenant, but allows it in another tenant", async () => {
    await expect(
      addDocument(
        db,
        { tenantId: tenantA, uploadedById: "admin_a", kind: "article", file: file(SSO) },
        deps,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      addDocument(
        db,
        { tenantId: tenantB, uploadedById: "admin_b", kind: "article", file: file(SSO) },
        deps,
      ),
    ).resolves.toMatchObject({ title: "Single sign-on" });
  });

  it("keeps the document usable by keyword when embedding fails, and re-indexes later", async () => {
    const failing = { embedPassages: async () => Promise.reject(new Error("out of memory")), log };
    const doc = await addDocument(
      db,
      {
        tenantId: tenantA,
        uploadedById: "admin_a",
        kind: "runbook",
        file: file("# Outage runbook\n\nPage the on-call engineer and post on the status page."),
      },
      failing,
    );
    expect(doc.semanticIndexed).toBe(false);
    expect(doc.errorMessage).toMatch(/keyword search still works/);

    const hits = await searchKnowledge(db, tenantA, "status page outage", { embedQuery: null });
    expect(hits.map((h) => h.documentTitle)).toContain("Outage runbook");

    await indexDocument(db, tenantA, doc.id, deps);
    const missing = await db
      .select()
      .from(documentChunks)
      .where(and(eq(documentChunks.documentId, doc.id), isNull(documentChunks.embedding)));
    expect(missing).toHaveLength(0);
    const [row] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row.errorMessage).toBeNull();
  });

  it("records keyword-only mode when semantic search is turned off", async () => {
    const doc = await addDocument(
      db,
      {
        tenantId: tenantA,
        uploadedById: "admin_a",
        kind: "article",
        file: file("# Plans\n\nPro plan costs 49 per month."),
      },
      { embedPassages: null, log },
    );
    expect(doc.errorMessage).toMatch(/turned off/);
  });
});

describe("searchKnowledge", () => {
  it("finds the right section by keyword and by vector, best first", async () => {
    const hits = await searchKnowledge(db, tenantA, "customer charged twice duplicate refund", {
      embedQuery: mockEmbedder.embedQuery,
    });
    expect(hits[0].documentTitle).toBe("Refunds");
    expect(hits[0].content).toContain("Duplicate charges");
    expect(hits[0].similarity).toBeGreaterThan(0);
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].score).toBeLessThanOrEqual(1);
  });

  it("works with keyword search alone, and with odd punctuation in the query", async () => {
    const hits = await searchKnowledge(db, tenantA, "SAML: metadata (XML) & 'email'?!", {
      embedQuery: null,
    });
    expect(hits[0].documentTitle).toBe("Single sign-on");
    expect(hits[0].similarity).toBeNull();
    expect(await searchKnowledge(db, tenantA, "   ", { embedQuery: null })).toEqual([]);
  });

  it("never returns another tenant's documents", async () => {
    const hits = await searchKnowledge(db, tenantA, "refund codes duplicate charge override 4242", {
      embedQuery: mockEmbedder.embedQuery,
    });
    expect(hits.every((h) => h.documentTitle !== "Tenant B secret")).toBe(true);
  });

  it("skips documents that are not ready", async () => {
    const [sso] = (await listDocuments(db, tenantA)).filter((d) => d.title === "Single sign-on");
    await db.update(documents).set({ status: "processing" }).where(eq(documents.id, sso.id));
    const hits = await searchKnowledge(db, tenantA, "SAML single sign-on", { embedQuery: null });
    expect(hits.every((h) => h.documentId !== sso.id)).toBe(true);
    await db.update(documents).set({ status: "ready" }).where(eq(documents.id, sso.id));
  });
});

describe("askKnowledgeBase", () => {
  const ask = (question: string, model = mockAnswerModel()) =>
    askKnowledgeBase(
      db,
      { tenantId: tenantA, userId: "agent_a", question },
      { embedQuery: mockEmbedder.embedQuery, model, log },
    );

  it("answers from the sources, saves the query with citations, and records usage", async () => {
    const model = mockAnswerModel();
    const result = await ask("How do I refund a duplicate charge?", model);

    expect(model.messages[0]).toContain("<sources>");
    expect(model.messages[0]).toContain('<source n="1" title="Refunds"');
    expect(result).toMatchObject({ mode: "ai", status: "answered", model: "mock-answer-model" });
    expect(result.sources.map((s) => s.n)).toEqual([1]);

    const [query] = await db.select().from(kbQueries).where(eq(kbQueries.id, result.queryId!));
    expect(query).toMatchObject({
      groundingStatus: "grounded",
      askedById: "agent_a",
      model: "mock-answer-model",
      inputTokens: 2000,
      outputTokens: 120,
      latencyMs: 55,
    });
    const cites = await db.select().from(citations).where(eq(citations.queryId, result.queryId!));
    expect(cites).toMatchObject([{ position: 1, documentTitle: "Refunds" }]);
  });

  it("drops citation numbers that don't exist and downgrades an uncited answer", async () => {
    const invented = await ask(
      "How do I refund a duplicate charge?",
      mockAnswerModel({ answer: "Use the refund tool [9].", cited_sources: [9] }),
    );
    expect(invented.status).toBe("insufficient_evidence");
    expect(invented.sources).toEqual([]);
    const [row] = await db.select().from(kbQueries).where(eq(kbQueries.id, invented.queryId!));
    expect(row.groundingStatus).toBe("insufficient_evidence");
  });

  it("returns the fallback without calling the model when nothing matches", async () => {
    const model = mockAnswerModel();
    const result = await askKnowledgeBase(
      db,
      { tenantId: tenantA, userId: "agent_a", question: "zzzz qqqq" },
      { embedQuery: null, model, log },
    );
    expect(result).toMatchObject({ status: "insufficient_evidence", answer: NO_SOURCES_ANSWER });
    expect(model.messages).toHaveLength(0);
  });

  it("returns matching sections when no model is configured (search-only mode)", async () => {
    const result = await askKnowledgeBase(
      db,
      { tenantId: tenantA, userId: "agent_a", question: "SAML metadata" },
      { embedQuery: null, model: null, log },
    );
    expect(result.mode).toBe("search_only");
    expect(result.answer).toBeNull();
    expect(result.sources[0].documentTitle).toBe("Single sign-on");
  });

  it("redacts PII in the question before the model sees it, and restores it in the answer", async () => {
    const model = mockAnswerModel((message) => ({
      answer: `Refund ${/\[EMAIL_\d\]/.exec(message)?.[0]} from the Billing page [1].`,
    }));
    const result = await ask("Refund the duplicate charge for priya@example.test?", model);
    expect(model.messages[0]).not.toContain("priya@example.test");
    expect(result.answer).toBe("Refund priya@example.test from the Billing page [1].");
  });
});

describe("deleteDocument", () => {
  it("deletes a document and its sections, keeps citation quotes, and is tenant-scoped", async () => {
    const result = await askKnowledgeBase(
      db,
      { tenantId: tenantA, userId: "agent_a", question: "How do I refund a duplicate charge?" },
      { embedQuery: mockEmbedder.embedQuery, model: mockAnswerModel(), log },
    );
    const [refunds] = (await listDocuments(db, tenantA)).filter((d) => d.title === "Refunds");

    await expect(
      deleteDocument(db, { tenantId: tenantB, documentId: refunds.id, actorId: "admin_b" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await deleteDocument(db, { tenantId: tenantA, documentId: refunds.id, actorId: "admin_a" });
    expect(
      await db.select().from(documentChunks).where(eq(documentChunks.documentId, refunds.id)),
    ).toHaveLength(0);
    const [cite] = await db.select().from(citations).where(eq(citations.queryId, result.queryId!));
    expect(cite).toMatchObject({ documentTitle: "Refunds", chunkId: null });
  });
});
