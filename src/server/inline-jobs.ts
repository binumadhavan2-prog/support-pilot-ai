import "server-only";
import { after } from "next/server";
import { getDb } from "@/db/client";
import { getEnv } from "@/env";
import { logger } from "@/lib/logger";
import { getTriageModel } from "./ai/model";
import { getMailer } from "./email/mailer";
import { processNextJob } from "./jobs";

/** Jobs run per request at most, so one request never does unbounded work. */
const MAX_JOBS_PER_REQUEST = 10;

/**
 * For hosts with no background worker (Vercel, free tiers): with RUN_JOBS_INLINE=true, the queue
 * is drained a little after each request that adds work, once the response has been sent. The
 * jobs stay in Postgres either way, so a real worker can be added later without changes, and a job
 * that fails here is retried by the next request (or worker) like any other.
 */
export function runQueuedJobsAfterResponse() {
  if (!getEnv().RUN_JOBS_INLINE) return;
  after(async () => {
    const services = { triageModel: getTriageModel, mailer: getMailer };
    try {
      for (let i = 0; i < MAX_JOBS_PER_REQUEST; i++) {
        if (!(await processNextJob(getDb(), services))) break;
      }
    } catch (error) {
      logger.error({ err: error }, "inline job processing failed");
    }
  });
}
