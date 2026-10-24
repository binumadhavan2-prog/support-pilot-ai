import { and, asc, eq, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { jobs } from "@/db/schema";
import type { AnyDatabase } from "@/db/types";
import { isAppError } from "@/lib/errors";
import { logger, type Logger } from "@/lib/logger";
import { triageTicket, type TriageModel } from "./ai/triage";
import type { Mailer } from "./email/mailer";
import { sendReplyEmail } from "./email/send-reply";

/*
 * A small job queue on Postgres. `enqueueJob` takes a transaction, so a job is queued only if the
 * change that needs it commits. `processNextJob` claims one due job with SKIP LOCKED, runs its
 * handler and records the result; `scripts/worker.mts` calls it in a loop.
 */

export const MAX_ATTEMPTS = 3;

const triageTicketPayload = z.object({ ticketId: z.uuid() });
const sendReplyEmailPayload = z.object({ messageId: z.uuid() });

/** External services a handler may need. Injected so tests can pass mocks. */
export interface JobServices {
  triageModel: () => TriageModel;
  /** Outbound email; omitted or null means sending is not configured. */
  mailer?: () => Mailer | null;
}

interface JobContext {
  db: AnyDatabase;
  tenantId: string;
  log: Logger;
  services: JobServices;
}

const handlers = {
  /** Redacts, classifies with the triage model, saves `triage_results` and routes the ticket. */
  triage_ticket: async (payload: unknown, { db, tenantId, log, services }: JobContext) => {
    const { ticketId } = triageTicketPayload.parse(payload);
    await triageTicket(db, services.triageModel(), { tenantId, ticketId, log });
  },
  /** Emails one agent reply to the customer (see email/send-reply.ts). */
  send_reply_email: async (payload: unknown, { db, tenantId, log, services }: JobContext) => {
    const { messageId } = sendReplyEmailPayload.parse(payload);
    await sendReplyEmail(db, services.mailer?.() ?? null, { tenantId, messageId, log });
  },
} satisfies Record<string, (payload: unknown, ctx: JobContext) => Promise<void>>;

export type JobType = keyof typeof handlers;

type Executor = Pick<AnyDatabase, "insert">;

export async function enqueueJob(
  executor: Executor,
  job: { tenantId: string; type: JobType; payload: Record<string, unknown> },
) {
  const [row] = await executor
    .insert(jobs)
    .values({ tenantId: job.tenantId, type: job.type, payload: job.payload })
    .returning({ id: jobs.id });
  return row;
}

function isJobType(type: string): type is JobType {
  return Object.hasOwn(handlers, type);
}

/**
 * Runs at most one due job. Returns its id and final status, or null when the queue is empty.
 * A failed job is retried (with a delay) until MAX_ATTEMPTS, then left as `failed`.
 */
export async function processNextJob(db: AnyDatabase, services: JobServices, log: Logger = logger) {
  const job = await db.transaction(async (tx) => {
    const [next] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, "queued"), lte(jobs.runAfter, sql`now()`)))
      .orderBy(asc(jobs.runAfter))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!next) return null;
    const [claimed] = await tx
      .update(jobs)
      .set({ status: "running", attempts: next.attempts + 1 })
      .where(eq(jobs.id, next.id))
      .returning();
    return claimed;
  });
  if (!job) return null;

  const jobLog = log.child({ jobId: job.id, jobType: job.type });
  try {
    if (!isJobType(job.type)) throw new Error(`Unknown job type: ${job.type}`);
    await handlers[job.type](job.payload, { db, tenantId: job.tenantId, log: jobLog, services });
    await db.update(jobs).set({ status: "succeeded", lastError: null }).where(eq(jobs.id, job.id));
    return { id: job.id, status: "succeeded" as const };
  } catch (error) {
    jobLog.error({ err: error, attempt: job.attempts }, "job failed");
    const retry = job.attempts < MAX_ATTEMPTS;
    await db
      .update(jobs)
      .set({
        status: retry ? "queued" : "failed",
        lastError: isAppError(error) ? error.message : (error as Error)?.name || "Error",
        // Back off 30s, then 60s, before the next attempt.
        runAfter: retry ? sql`now() + ${`${30 * job.attempts} seconds`}::interval` : job.runAfter,
      })
      .where(eq(jobs.id, job.id));
    return { id: job.id, status: retry ? ("queued" as const) : ("failed" as const) };
  }
}
