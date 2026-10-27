import { randomUUID } from "node:crypto";
import { logger } from "@/lib/logger";
import type { Mailer } from "./mailer";
import { isReservedAddress } from "./outbound";

/*
 * Password-reset and email-verification emails, sent by Better Auth's callbacks. The links carry
 * single-use tokens, so they are never logged; only the outcome is.
 */

export type AuthEmailKind = "password_reset" | "email_verification";

const CONTENT: Record<
  AuthEmailKind,
  { subject: string; body: (name: string, url: string) => string }
> = {
  password_reset: {
    subject: "Reset your Support Pilot AI password",
    body: (name, url) =>
      `Hi ${name},\n\nSomeone asked to reset the password for your Support Pilot AI account. If it was you, open this link within 1 hour to choose a new password:\n\n${url}\n\nIf you didn't ask for this, ignore this email; your password stays the same.`,
  },
  email_verification: {
    subject: "Confirm your email for Support Pilot AI",
    body: (name, url) =>
      `Hi ${name},\n\nPlease confirm this is your email address by opening this link within 24 hours:\n\n${url}\n\nIf you don't have a Support Pilot AI account, ignore this email.`,
  },
};

/**
 * Sends one auth email. Never throws: a failure is logged, and the caller's response stays the
 * same either way (so it reveals nothing about whether an account exists).
 * Returns what happened, for tests and the audit log.
 */
export async function sendAuthEmail(
  mailer: Mailer | null,
  kind: AuthEmailKind,
  user: { id: string; email: string; name: string },
  url: string,
): Promise<"sent" | "not_configured" | "reserved_address" | "failed"> {
  const log = logger.child({ kind, userId: user.id });
  if (!mailer) {
    log.warn("auth email not sent: email sending is not configured");
    return "not_configured";
  }
  // Demo and test accounts use reserved domains; never send real mail to them.
  if (isReservedAddress(user.email)) {
    log.info("auth email skipped: reserved test address");
    return "reserved_address";
  }
  const content = CONTENT[kind];
  const name = user.name.trim().split(/\s+/)[0] || "there";
  try {
    await mailer.send({
      to: user.email,
      subject: content.subject,
      text: content.body(name, url),
      idempotencyKey: randomUUID(),
    });
    log.info("auth email sent");
    return "sent";
  } catch (error) {
    log.error({ err: error }, "auth email failed");
    return "failed";
  }
}
