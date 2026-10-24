import "server-only";
import { z } from "zod";
import { getEnv } from "@/env";
import { AppError } from "@/lib/errors";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  /** Same key on a retry means the provider sends the email at most once. */
  idempotencyKey: string;
}

export interface Mailer {
  provider: string;
  send(email: OutgoingEmail): Promise<{ providerId: string }>;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 10_000;
const resendResponse = z.object({ id: z.string().min(1) });

/** Resend over plain fetch (no SDK). Plain text only, so customer-visible HTML can't be injected. */
export function createResendMailer({ apiKey, from }: { apiKey: string; from: string }): Mailer {
  return {
    provider: "resend",
    async send({ to, subject, text, idempotencyKey }) {
      let response: Response;
      try {
        response = await fetch(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({ from, to: [to], subject, text }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (error) {
        throw new AppError("UPSTREAM_ERROR", "Could not reach the email provider", {
          cause: error,
        });
      }
      if (!response.ok) {
        // The provider's error text stays out of the message (it is logged via the cause only).
        throw new AppError(
          "UPSTREAM_ERROR",
          `The email provider rejected the message (HTTP ${response.status})`,
          { cause: new Error((await response.text().catch(() => "")).slice(0, 500)) },
        );
      }
      const parsed = resendResponse.safeParse(await response.json().catch(() => null));
      if (!parsed.success) {
        throw new AppError("UPSTREAM_ERROR", "The email provider returned an unexpected response");
      }
      return { providerId: parsed.data.id };
    },
  };
}

let mailer: Mailer | undefined;

/** The configured mailer, or null when RESEND_API_KEY is not set (replies are not emailed). */
export function getMailer(): Mailer | null {
  const env = getEnv();
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return null;
  mailer ??= createResendMailer({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM });
  return mailer;
}

export function isEmailConfigured() {
  return getMailer() !== null;
}
