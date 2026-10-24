import type { AnyDatabase } from "@/db/types";
import { enqueueJob } from "../jobs";

/*
 * Deciding whether an agent reply is emailed. The reply's transaction records the decision on the
 * message and queues a `send_reply_email` job, so an email is queued only if the reply commits.
 */

/** RFC 2606 / 6761 names that never belong to a real customer (test data, demo data). */
const RESERVED_DOMAIN = /(^|\.)(example\.(com|net|org)|example|test|invalid|localhost)$/i;

export function isReservedAddress(email: string) {
  const domain = email.split("@").pop() ?? "";
  return RESERVED_DOMAIN.test(domain);
}

export interface ReplyEmailPlan {
  emailStatus: "queued" | "skipped";
  emailDetail: string | null;
}

/** Demo tickets and reserved addresses are never emailed, even when sending is configured. */
export function planReplyEmail(
  ticket: { customerEmail: string; externalRef: string | null },
  { enabled }: { enabled: boolean },
): ReplyEmailPlan {
  if (ticket.externalRef !== null) {
    return { emailStatus: "skipped", emailDetail: "Imported or demo ticket: not emailed" };
  }
  if (isReservedAddress(ticket.customerEmail)) {
    return { emailStatus: "skipped", emailDetail: "Test address: not emailed" };
  }
  if (!enabled) {
    return { emailStatus: "skipped", emailDetail: "Email sending is not configured" };
  }
  return { emailStatus: "queued", emailDetail: null };
}

/** Call inside the reply's transaction, after inserting the message with the plan's fields. */
export async function queueReplyEmail(
  tx: Pick<AnyDatabase, "insert">,
  { tenantId, messageId, plan }: { tenantId: string; messageId: string; plan: ReplyEmailPlan },
) {
  if (plan.emailStatus !== "queued") return;
  await enqueueJob(tx, { tenantId, type: "send_reply_email", payload: { messageId } });
}
