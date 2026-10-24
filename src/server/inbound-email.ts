import PostalMime from "postal-mime";
import { AppError } from "@/lib/errors";
import { createTicketSchema, type CreateTicketInput } from "./tickets";

/** Raw RFC 5322 messages larger than this are rejected before parsing. */
export const MAX_RAW_EMAIL_BYTES = 2 * 1024 * 1024;

/** Fallback for HTML-only emails. Good enough for a ticket body; never rendered as HTML. */
function htmlToText(html: string) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Turns a raw inbound email (as delivered by an email provider's "raw MIME" webhook) into ticket
 * input: sender becomes the customer, subject the ticket subject, the text part the first message.
 */
export async function parseInboundEmail(
  raw: string,
): Promise<{ input: CreateTicketInput; messageId: string | null }> {
  let email;
  try {
    email = await PostalMime.parse(raw);
  } catch {
    throw new AppError("VALIDATION_ERROR", "Request body is not a valid email message");
  }

  // A From header can be a group ("Team: a@x, b@y;"); the first member is the sender.
  const from = email.from?.group ? email.from.group[0] : email.from;
  if (!from?.address) {
    throw new AppError("VALIDATION_ERROR", "Email has no sender address");
  }

  const body = email.text?.trim() || (email.html ? htmlToText(email.html).trim() : "");
  const parsed = createTicketSchema.safeParse({
    subject: email.subject?.trim() || "(no subject)",
    body,
    customer: { name: from.name?.trim() || from.address, email: from.address },
  });
  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "Email could not be turned into a ticket", {
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  // The Message-ID identifies this email across provider retries (used as the idempotency key).
  const messageId = email.messageId?.trim().slice(0, 200) || null;
  return { input: parsed.data, messageId };
}
