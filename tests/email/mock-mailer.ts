import { AppError } from "@/lib/errors";
import type { Mailer, OutgoingEmail } from "@/server/email/mailer";

/**
 * MOCK mailer: no network, nothing is delivered. Records every email it is asked to send, and
 * can fail the first `failTimes` sends to exercise retries.
 */
export function mockMailer({ failTimes = 0 } = {}): Mailer & { sent: OutgoingEmail[] } {
  const sent: OutgoingEmail[] = [];
  let failures = 0;
  return {
    provider: "mock",
    sent,
    async send(email) {
      if (failures < failTimes) {
        failures++;
        throw new AppError("UPSTREAM_ERROR", "The email provider rejected the message (HTTP 503)");
      }
      sent.push(email);
      return { providerId: `mock-${sent.length}` };
    },
  };
}
