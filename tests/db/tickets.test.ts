import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiKeys, auditLogs, jobs, ticketMessages, tickets, tenants } from "@/db/schema";
import { createApiKey, revokeApiKey, verifyApiKey } from "@/server/api-keys";
import { MAX_ATTEMPTS, STALE_JOB_MINUTES, enqueueJob, processNextJob } from "@/server/jobs";
import {
  createTicket,
  getTicket,
  listTickets,
  listTicketsQuerySchema,
  type CreateTicketInput,
} from "@/server/tickets";
import { mockTriageModel } from "../ai/mock-triage-model";
import { createTestDb, type TestDb } from "./test-db";

/* Ticket, API key and job services on a migrated in-memory Postgres (PGlite). */

let db: TestDb;
let close: () => Promise<void>;
let tenantA: string;
let tenantB: string;

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
});

afterAll(async () => {
  await close?.();
});

const input = (overrides: Partial<CreateTicketInput> = {}): CreateTicketInput => ({
  subject: "Invoice charged twice",
  body: "I was billed twice for March.",
  customer: { name: "Priya N", email: "priya@example.test" },
  ...overrides,
});

const query = (q: Record<string, unknown> = {}) => listTicketsQuerySchema.parse(q);

describe("createTicket", () => {
  it("stores the ticket, its first message, an audit row and a triage job atomically", async () => {
    const ticket = await createTicket(db, tenantA, input(), {
      actor: apiActor,
      source: "api",
      requestId: "req-12345678",
    });

    expect(ticket).toMatchObject({ tenantId: tenantA, status: "open", priority: "normal" });
    const messages = await db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, ticket.id));
    expect(messages).toMatchObject([
      { authorType: "customer", body: "I was billed twice for March." },
    ]);

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, ticket.id));
    expect(audit).toMatchObject({
      tenantId: tenantA,
      actorId: null,
      action: "ticket.created",
      requestId: "req-12345678",
    });
    expect(audit.metadata).toMatchObject({ source: "api", apiKeyId: apiActor.apiKeyId });

    const queued = await db.select().from(jobs).where(eq(jobs.tenantId, tenantA));
    expect(queued.find((j) => j.payload.ticketId === ticket.id)).toMatchObject({
      type: "triage_ticket",
      status: "queued",
    });
  });

  it("rolls everything back when a step fails", async () => {
    const before = await db.select().from(tickets);
    // A tenant id that does not exist makes the first insert fail its foreign key.
    await expect(
      createTicket(db, "00000000-0000-4000-8000-0000000000ff", input(), {
        actor: apiActor,
        source: "api",
      }),
    ).rejects.toThrow();
    expect(await db.select().from(tickets)).toHaveLength(before.length);
  });
});

describe("listTickets", () => {
  beforeAll(async () => {
    const opts = { actor: apiActor, source: "api" as const };
    await createTicket(db, tenantA, input({ subject: "Login loop on mobile" }), opts);
    await createTicket(
      db,
      tenantA,
      input({ subject: "Server down 100% of the time", priority: "urgent" }),
      opts,
    );
    await createTicket(db, tenantB, input({ subject: "Tenant B secret ticket" }), opts);
  });

  it("returns only the caller's tenant", async () => {
    const a = await listTickets(db, tenantA, query());
    const b = await listTickets(db, tenantB, query());
    expect(a.items.every((t) => t.subject !== "Tenant B secret ticket")).toBe(true);
    expect(b.items.map((t) => t.subject)).toEqual(["Tenant B secret ticket"]);
  });

  it("filters by status, priority and category", async () => {
    const urgent = await listTickets(db, tenantA, query({ priority: "urgent" }));
    expect(urgent.items.map((t) => t.subject)).toEqual(["Server down 100% of the time"]);
    expect((await listTickets(db, tenantA, query({ status: "closed" }))).total).toBe(0);
    // New tickets are untriaged until the AI job fills in a category.
    expect((await listTickets(db, tenantA, query({ category: "billing" }))).total).toBe(0);
  });

  it("searches subject, customer and number, treating LIKE wildcards literally", async () => {
    expect((await listTickets(db, tenantA, query({ search: "login" }))).total).toBe(1);
    expect((await listTickets(db, tenantA, query({ search: "PRIYA@" }))).total).toBeGreaterThan(0);
    expect((await listTickets(db, tenantA, query({ search: "100%" }))).total).toBe(1);
    expect((await listTickets(db, tenantA, query({ search: "%" }))).total).toBe(1);

    const [first] = (await listTickets(db, tenantA, query({ search: "login" }))).items;
    const byNumber = await listTickets(db, tenantA, query({ search: `#${first.number}` }));
    expect(byNumber.items.map((t) => t.id)).toEqual([first.id]);
  });

  it("paginates newest first", async () => {
    const all = await listTickets(db, tenantA, query());
    const page1 = await listTickets(db, tenantA, query({ pageSize: 2 }));
    const page2 = await listTickets(db, tenantA, query({ pageSize: 2, page: 2 }));
    expect(page1.totalPages).toBe(Math.ceil(all.total / 2));
    expect([...page1.items, ...page2.items].map((t) => t.id)).toEqual(
      all.items.slice(0, 4).map((t) => t.id),
    );
  });
});

describe("getTicket", () => {
  it("returns the ticket with its messages", async () => {
    const created = await createTicket(db, tenantA, input(), { actor: apiActor, source: "api" });
    const ticket = await getTicket(db, tenantA, created.id);
    expect(ticket.subject).toBe("Invoice charged twice");
    expect(ticket.isDemo).toBe(false);
    expect(ticket.messages).toHaveLength(1);
  });

  it("gives the same NOT_FOUND for another tenant's ticket, a missing id and a malformed id", async () => {
    const created = await createTicket(db, tenantA, input(), { actor: apiActor, source: "api" });
    for (const id of [created.id, "00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      await expect(getTicket(db, tenantB, id)).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Ticket not found",
      });
    }
  });
});

describe("API keys", () => {
  it("verify to their tenant and store only a hash", async () => {
    const { id, key } = await createApiKey(db, { tenantId: tenantA, name: "Webhook" });
    expect(key).toMatch(/^sp_/);
    expect(await verifyApiKey(db, key)).toEqual({ id, tenantId: tenantA });

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
    expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(key.slice(10));
  });

  it("reject unknown, malformed and revoked keys", async () => {
    const { id, key } = await createApiKey(db, { tenantId: tenantA, name: "Old" });
    expect(await verifyApiKey(db, `${key.slice(0, -1)}x`)).toBeNull();
    expect(await verifyApiKey(db, "sp_short")).toBeNull();
    expect(await revokeApiKey(db, tenantB, id)).toBe(false); // other tenant cannot revoke it
    expect(await revokeApiKey(db, tenantA, id)).toBe(true);
    expect(await verifyApiKey(db, key)).toBeNull();
  });
});

describe("job queue", () => {
  // MOCK model: no network calls in tests.
  const services = { triageModel: () => mockTriageModel() };

  it("reclaims a job left running by a stopped worker, but not a recent one", async () => {
    while (await processNextJob(db, services));
    const created = await createTicket(db, tenantA, input(), { actor: apiActor, source: "api" });
    const [job] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.payload, { ticketId: created.id }));
    // A worker claimed it a minute ago and is still on it: leave it alone.
    await db
      .update(jobs)
      .set({ status: "running", attempts: 1, updatedAt: new Date(Date.now() - 60_000) })
      .where(eq(jobs.id, job.id));
    expect(await processNextJob(db, services)).toBeNull();

    // Its worker died long ago: claim it again and finish it.
    await db
      .update(jobs)
      .set({ updatedAt: new Date(Date.now() - (STALE_JOB_MINUTES + 1) * 60_000) })
      .where(eq(jobs.id, job.id));
    expect(await processNextJob(db, services)).toEqual({ id: job.id, status: "succeeded" });
    const [after] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(after.attempts).toBe(2);
  });

  it("fails a job that stalled on its last attempt instead of running it again", async () => {
    const { id } = await enqueueJob(db, {
      tenantId: tenantA,
      type: "triage_ticket",
      payload: { ticketId: "00000000-0000-4000-8000-0000000000aa" },
    });
    await db
      .update(jobs)
      .set({ status: "running", attempts: MAX_ATTEMPTS, updatedAt: new Date(0) })
      .where(eq(jobs.id, id));
    expect(await processNextJob(db, services)).toBeNull();
    const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
    expect(job).toMatchObject({ status: "failed", lastError: "The worker stopped during the job" });
  });

  it("runs triage (with a mock model) and marks the job succeeded", async () => {
    // Drain jobs queued by earlier tests first.
    while (await processNextJob(db, services));
    const created = await createTicket(db, tenantA, input(), { actor: apiActor, source: "api" });
    const result = await processNextJob(db, services);
    expect(result?.status).toBe("succeeded");
    const [job] = await db.select().from(jobs).where(eq(jobs.id, result!.id));
    expect(job).toMatchObject({ status: "succeeded", attempts: 1 });
    expect(job.payload).toEqual({ ticketId: created.id });
    expect(await processNextJob(db, services)).toBeNull();
  });

  it("retries a failing job with a delay, then marks it failed", async () => {
    const { id } = await enqueueJob(db, {
      tenantId: tenantA,
      type: "triage_ticket",
      payload: { ticketId: "not-a-uuid" }, // fails payload validation
    });
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Make the job due again (the retry delay is in the future).
      await db
        .update(jobs)
        .set({ runAfter: new Date(0) })
        .where(eq(jobs.id, id));
      const result = await processNextJob(db, services);
      expect(result).toEqual({ id, status: attempt < MAX_ATTEMPTS ? "queued" : "failed" });
    }
    const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
    expect(job).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS, lastError: "ZodError" });
  });
});

describe("idempotent creation", () => {
  it("returns the first ticket for a repeated key, without a second ticket, job or audit row", async () => {
    const opts = { actor: apiActor, source: "api" as const, idempotencyKey: "delivery-123" };
    const first = await createTicket(db, tenantA, input({ subject: "Webhook retry" }), opts);
    const again = await createTicket(db, tenantA, input({ subject: "Webhook retry" }), opts);
    expect(first.replayed).toBe(false);
    expect(again).toMatchObject({ id: first.id, replayed: true });

    const rows = await db.select().from(tickets).where(eq(tickets.idempotencyKey, "delivery-123"));
    expect(rows).toHaveLength(1);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, first.id));
    expect(audits).toHaveLength(1);
    const queued = await db.select().from(jobs);
    expect(queued.filter((j) => j.payload.ticketId === first.id)).toHaveLength(1);
  });

  it("scopes keys to the tenant", async () => {
    const opts = { actor: apiActor, source: "api" as const, idempotencyKey: "shared-key" };
    const a = await createTicket(db, tenantA, input(), opts);
    const b = await createTicket(db, tenantB, input(), opts);
    expect(b.id).not.toBe(a.id);
    expect(b.replayed).toBe(false);
  });

  it("creates exactly one ticket when the same delivery arrives twice at once", async () => {
    const opts = { actor: apiActor, source: "api" as const, idempotencyKey: "race-1" };
    const [x, y] = await Promise.all([
      createTicket(db, tenantA, input(), opts),
      createTicket(db, tenantA, input(), opts),
    ]);
    expect(x.id).toBe(y.id);
    expect([x.replayed, y.replayed].sort()).toEqual([false, true]);
    const rows = await db.select().from(tickets).where(eq(tickets.idempotencyKey, "race-1"));
    expect(rows).toHaveLength(1);
  });
});
