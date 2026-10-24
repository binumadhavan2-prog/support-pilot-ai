/**
 * Background job worker: runs queued jobs (e.g. triage_ticket) until stopped with Ctrl+C.
 * Triage calls the Claude API (needs ANTHROPIC_API_KEY; each ticket is one paid request).
 *
 *   npm run jobs:work
 */
import { logger } from "@/lib/logger";
import { getTriageModel } from "@/server/ai/model";
import { processNextJob } from "@/server/jobs";
import { createScriptAuth } from "./lib/script-auth";

const IDLE_DELAY_MS = 2000;

const { db, close } = createScriptAuth();
let stopping = false;
// SIGTERM is what `docker stop` and orchestrators send; finish the current job, then exit.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

logger.info("worker started");
try {
  while (!stopping) {
    const result = await processNextJob(db, { triageModel: getTriageModel }).catch(
      (error: unknown) => {
        logger.error({ err: error }, "worker: could not poll the queue");
        return null;
      },
    );
    // Drain the queue quickly; poll slowly when it is empty.
    if (!result) await new Promise((resolve) => setTimeout(resolve, IDLE_DELAY_MS));
  }
} finally {
  await close();
  logger.info("worker stopped");
}
