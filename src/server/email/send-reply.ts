import { and, eq } from "drizzle-orm";
import { ticketMessages, tickets } from "@/db/schema";
import type { AnyDatabase } from "@/db/types";
import { AppError, isAppError } from "@/lib/errors";
import type { Logger } from "@/lib/logger";
import { recordAudit } from "../audit";
import type { Mailer } from "./mailer";

export function replySubject(ticket: { subject: string; number: number }) {
  const subject = ticket.subject.replace(/^(re:\s*)+/i, "");
  return `Re: ${subject} [#${ticket.number}]`;
}

/**
 * Job body for `send_reply_email`: emails one agent reply to the ticket's customer. Safe to retry:
 * a message already sent or skipped is left alone, and the message id is the provider's
 * idempotency key, so a retry after a lost response does not send twice.
 */
export async function sendReplyEmail(
  db: AnyDatabase,
  mailer: Mailer | null,
  { tenantId, messageId, log }: { tenantId: string; messageId: string; log: Logger },
) {
  const [row] = await db
    .select({
      body: ticketMessages.body,
      emailStatus: ticketMessages.emailStatus,
      ticketId: tickets.id,
      number: tickets.number,
      subject: tickets.subject,
      customerEmail: tickets.customerEmail,
    })
    .from(ticketMessages)
    .innerJoin(
      tickets,
      and(eq(tickets.id, ticketMessages.ticketId), eq(tickets.tenantId, ticketMessages.tenantId)),
    )
    .where(and(eq(ticketMessages.id, messageId), eq(ticketMessages.tenantId, tenantId)));
  if (!row) throw new AppError("NOT_FOUND", "Message not found");
  if (row.emailStatus !== "queued" && row.emailStatus !== "failed") return;

  const where = and(eq(ticketMessages.id, messageId), eq(ticketMessages.tenantId, tenantId));
  if (!mailer) {
    // Configuration was removed after the reply was queued.
    await db
      .update(ticketMessages)
      .set({ emailStatus: "skipped", emailDetail: "Email sending is not configured" })
      .where(where);
    return;
  }

  try {
    const { providerId } = await mailer.send({
      to: row.customerEmail,
      subject: replySubject(row),
      text: `${row.body}\n\n--\nTicket #${row.number}`,
      idempotencyKey: messageId,
    });
    await db.transaction(async (tx) => {
      await tx
        .update(ticketMessages)
        .set({
          emailStatus: "sent",
          emailDetail: null,
          emailProviderId: providerId,
          emailSentAt: new Date(),
        })
        .where(where);
      await recordAudit(
        {
          tenantId,
          actorId: null,
          action: "ticket.reply_emailed",
          entityType: "ticket",
          entityId: row.ticketId,
          metadata: { messageId, provider: mailer.provider },
        },
        tx,
      );
    });
    log.info({ messageId, provider: mailer.provider }, "reply emailed");
  } catch (error) {
    await db
      .update(ticketMessages)
      .set({
        emailStatus: "failed",
        emailDetail: isAppError(error) ? error.message : "Sending failed",
      })
      .where(where);
    throw error; // the job queue retries with backoff
  }
}
