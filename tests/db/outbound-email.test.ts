import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiDrafts, auditLogs, jobs, tenants, ticketMessages, tickets, user } from "@/db/schema";
import { logger } from "@/lib/logger";
import { reviewDraft } from "@/server/ai/drafts";
import { isReservedAddress, planReplyEmail } from "@/server/email/outbound";
import { replySubject, sendReplyEmail } from "@/server/email/send-reply";
import { processNextJob } from "@/server/jobs";
import { addAgentReply, createTicket, getTicket } from "@/server/tickets";
import { mockTriageModel } from "../ai/mock-triage-model";
import { mockMailer } from "../email/mock-mailer";
import { createTestDb, type TestDb } from "./test-db";

/* Outbound reply email on PGlite, with a MOCK mailer and triage model (no network). */

let db: TestDb;
let close: () => Promise<void>;
let tenantA: string;
let tenantB: string;
const log = logger.child({ test: "outbound-email" });
const apiActor = { type: "api_key" as const, apiKeyId: "00000000-0000-4000-8000-000000000001" };

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
  await db
    .insert(user)
    .values([
      { id: "agent_sam", tenantId: tenantA, name: "Sam", email: "sam@a.test", role: "agent" },
    ]);
});

afterAll(async () => {
  await close?.();
});

/** Not a reserved domain, so it is eligible for email (the mailer is a mock). */
async function ticket(email = "dana@customer-mail.net") {
  return createTicket(
    db,
    tenantA,
    {
      subject: "Export broken",
      body: "The export button does nothing.",
      customer: { name: "Dana", email },
    },
    { actor: apiActor, source: "api" },
  );
}

async function message(id: string) {
  const [row] = await db.select().from(ticketMessages).where(eq(ticketMessages.id, id));
  return row;
}

async function jobsFor(messageId: string) {
  const rows = await db.select().from(jobs).where(eq(jobs.type, "send_reply_email"));
  return rows.filter((j) => j.payload.messageId === messageId);
}

const ctx = (ticketId: string) => ({ tenantId: tenantA, ticketId, authorId: "agent_sam" });

describe("planReplyEmail", () => {
  it("skips demo tickets, reserved addresses and unconfigured sending", () => {
    const real = { customerEmail: "dana@customer-mail.net", externalRef: null };
    expect(planReplyEmail(real, { enabled: true })).toEqual({
      emailStatus: "queued",
      emailDetail: null,
    });
    expect(planReplyEmail(real, { enabled: false })).toMatchObject({ emailStatus: "skipped" });
    expect(planReplyEmail({ ...real, externalRef: "T-0042" }, { enabled: true })).toMatchObject({
      emailStatus: "skipped",
      emailDetail: expect.stringMatching(/demo/),
    });
  });

  it("recognises reserved test domains", () => {
    for (const email of [
      "a@x.test",
      "a@acmecloud.example",
      "a@example.com",
      "a@mail.example.org",
      "a@localhost",
    ]) {
      expect(isReservedAddress(email)).toBe(true);
    }
    for (const email of ["a@gmail.com", "a@example-shop.com", "a@testing.io"]) {
      expect(isReservedAddress(email)).toBe(false);
    }
  });

  it("builds a threaded subject without stacking Re:", () => {
    expect(replySubject({ subject: "Re: RE: Export broken", number: 1042 })).toBe(
      "Re: Export broken [#1042]",
    );
  });
});

describe("agent replies", () => {
  it("records 'not configured' and queues nothing when sending is off", async () => {
    const t = await ticket();
    const reply = await addAgentReply(db, ctx(t.id), { body: "Looking into it." });
    expect(await message(reply.id)).toMatchObject({
      emailStatus: "skipped",
      emailDetail: "Email sending is not configured",
    });
    expect(await jobsFor(reply.id)).toHaveLength(0);
  });

  it("never queues email for a demo ticket", async () => {
    const t = await ticket();
    await db.update(tickets).set({ externalRef: "T-9999" }).where(eq(tickets.id, t.id));
    const reply = await addAgentReply(db, ctx(t.id), { body: "Hi" }, { emailEnabled: true });
    expect((await message(reply.id)).emailStatus).toBe("skipped");
    expect(await jobsFor(reply.id)).toHaveLength(0);
  });

  it("queues, sends through the worker, and audits the delivery", async () => {
    const mailer = mockMailer();
    const services = { triageModel: () => mockTriageModel(), mailer: () => mailer };
    const t = await ticket();
    const reply = await addAgentReply(
      db,
      ctx(t.id),
      { body: "Fixed now." },
      { emailEnabled: true },
    );
    expect(reply.emailStatus).toBe("queued");
    expect(await jobsFor(reply.id)).toHaveLength(1);

    while (await processNextJob(db, services));

    const row = await message(reply.id);
    expect(row).toMatchObject({
      emailStatus: "sent",
      emailDetail: null,
      emailProviderId: "mock-1",
    });
    expect(row.emailSentAt).toBeInstanceOf(Date);
    const { number } = await getTicket(db, tenantA, t.id);
    expect(mailer.sent).toEqual([
      {
        to: "dana@customer-mail.net",
        subject: `Re: Export broken [#${number}]`,
        text: `Fixed now.\n\n--\nTicket #${number}`,
        idempotencyKey: reply.id,
      },
    ]);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, t.id), eq(auditLogs.action, "ticket.reply_emailed")));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: null,
      metadata: { messageId: reply.id, provider: "mock" },
    });
  });

  it("marks a failed send, retries it, and never sends twice", async () => {
    const mailer = mockMailer({ failTimes: 1 });
    const t = await ticket();
    const reply = await addAgentReply(db, ctx(t.id), { body: "Retry me" }, { emailEnabled: true });

    await expect(
      sendReplyEmail(db, mailer, { tenantId: tenantA, messageId: reply.id, log }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(await message(reply.id)).toMatchObject({
      emailStatus: "failed",
      emailDetail: "The email provider rejected the message (HTTP 503)",
    });

    await sendReplyEmail(db, mailer, { tenantId: tenantA, messageId: reply.id, log });
    expect((await message(reply.id)).emailStatus).toBe("sent");
    // Running the job again after success is a no-op.
    await sendReplyEmail(db, mailer, { tenantId: tenantA, messageId: reply.id, log });
    expect(mailer.sent).toHaveLength(1);
  });

  it("skips at send time if sending was turned off after queueing", async () => {
    const t = await ticket();
    const reply = await addAgentReply(db, ctx(t.id), { body: "Hi" }, { emailEnabled: true });
    await sendReplyEmail(db, null, { tenantId: tenantA, messageId: reply.id, log });
    expect((await message(reply.id)).emailStatus).toBe("skipped");
  });

  it("can't send another tenant's message", async () => {
    const t = await ticket();
    const reply = await addAgentReply(db, ctx(t.id), { body: "Hi" }, { emailEnabled: true });
    await expect(
      sendReplyEmail(db, mockMailer(), { tenantId: tenantB, messageId: reply.id, log }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await message(reply.id)).emailStatus).toBe("queued");
  });

  it("shows the delivery status on the ticket", async () => {
    const t = await ticket();
    await addAgentReply(db, ctx(t.id), { body: "Hi" });
    const { messages } = await getTicket(db, tenantA, t.id);
    expect(messages.map((m) => m.emailStatus)).toEqual([null, "skipped"]);
  });
});

describe("approved AI drafts", () => {
  it("queue an email like a typed reply", async () => {
    const t = await ticket();
    const [draft] = await db
      .insert(aiDrafts)
      .values({
        tenantId: tenantA,
        ticketId: t.id,
        body: "Here is the fix.",
        groundingStatus: "grounded",
        model: "mock-draft-model",
      })
      .returning();
    const result = await reviewDraft(
      db,
      { tenantId: tenantA, reviewer: { id: "agent_sam", name: "Sam" } },
      { draftId: draft.id, decision: "approve", body: draft.body },
      { emailEnabled: true },
    );
    expect(result).toMatchObject({ status: "approved", emailStatus: "queued" });
    const [sent] = await db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.sourceDraftId, draft.id));
    expect(sent.emailStatus).toBe("queued");
    expect(await jobsFor(sent.id)).toHaveLength(1);
  });
});
