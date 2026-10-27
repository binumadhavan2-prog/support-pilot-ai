import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { jobs, tenants, tickets } from "@/db/schema";
import { createTestDb, type TestDb } from "./test-db";

/* RUN_JOBS_INLINE on PGlite: work queued by a request runs after its response, with no worker. */

const ctx = vi.hoisted(() => ({
  db: undefined as unknown,
  inline: true,
  scheduled: [] as (() => Promise<void>)[],
}));
vi.mock("@/db/client", () => ({ getDb: () => ctx.db }));
vi.mock("@/env", () => ({
  // No Claude or Resend key: triage uses the built-in rules (free, no network).
  getEnv: () => ({ RUN_JOBS_INLINE: ctx.inline, SEMANTIC_SEARCH: "off" }),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  // Collect the callbacks instead of waiting for a real response to finish.
  after: (callback: () => Promise<void>) => void ctx.scheduled.push(callback),
}));

const { runQueuedJobsAfterResponse } = await import("@/server/inline-jobs");
const { createTicket } = await import("@/server/tickets");

let db: TestDb;
let close: () => Promise<void>;
let tenantId: string;
const actor = { type: "api_key" as const, apiKeyId: "00000000-0000-4000-8000-000000000001" };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ctx.db = db;
  [{ id: tenantId }] = await db.insert(tenants).values({ slug: "acme", name: "Acme" }).returning();
});

afterAll(async () => {
  await close?.();
});

const newTicket = () =>
  createTicket(
    db,
    tenantId,
    {
      subject: "Charged twice",
      body: "My invoice was charged twice, please refund.",
      customer: { name: "Dana", email: "dana@x.test" },
    },
    { actor, source: "api" },
  );

describe("runQueuedJobsAfterResponse", () => {
  it("triages a new ticket after the response when enabled", async () => {
    ctx.inline = true;
    runQueuedJobsAfterResponse();
    const { id } = await newTicket();
    expect(ctx.scheduled).toHaveLength(1);

    await ctx.scheduled.shift()!();
    const [row] = await db.select().from(tickets).where(eq(tickets.id, id));
    expect(row).toMatchObject({ category: "billing", team: "billing" });
    const [job] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.payload, { ticketId: id }));
    expect(job.status).toBe("succeeded");
  });

  it("does nothing when disabled, leaving the job for a worker", async () => {
    ctx.inline = false;
    runQueuedJobsAfterResponse();
    const { id } = await newTicket();
    expect(ctx.scheduled).toHaveLength(0);
    const [job] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.payload, { ticketId: id }));
    expect(job.status).toBe("queued");
  });
});
