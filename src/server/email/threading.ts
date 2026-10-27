import { and, eq, sql } from "drizzle-orm";
import { ticketMessages, tickets } from "@/db/schema";
import type { AnyDatabase } from "@/db/types";
import { logger } from "@/lib/logger";
import { recordAudit } from "../audit";

/*
 * Threading inbound email onto existing tickets. Our reply emails carry "[#1042]" in the subject
 * (see send-reply.ts), and mail clients keep it when the customer replies. A reply is added to
 * that ticket only if the sender is the ticket's customer: a ticket number alone is guessable, so
 * it must never be enough to write into someone else's conversation.
 */

const TICKET_REF = /\[#(\d{1,10})\]/;

export function ticketNumberFromSubject(subject: string): number | null {
  const match = TICKET_REF.exec(subject);
  return match ? Number(match[1]) : null;
}

// Where a mail client starts quoting the message being replied to.
const QUOTE_START = [
  /^On .{1,300}wrote:\s*$/i, // Gmail, Apple Mail, Thunderbird
  /^-{2,}\s*Original Message\s*-{2,}/i, // Outlook
  /^_{10,}\s*$/, // Outlook (web)
  /^From:\s.+$/i, // Outlook header block
];

/**
 * The new part of a reply: everything before the quoted history, without `>` lines. Falls back to
 * the whole text if stripping would leave nothing (e.g. a reply typed inside the quote).
 */
export function stripQuotedReply(body: string) {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const cut = lines.findIndex((line) => QUOTE_START.some((re) => re.test(line.trim())));
  const kept = (cut === -1 ? lines : lines.slice(0, cut)).filter((l) => !/^\s*>/.test(l));
  const text = kept.join("\n").trim();
  return text || body.trim();
}

type ThreadResult = { ticket: typeof tickets.$inferSelect; replayed: boolean };

/**
 * Adds a customer's emailed reply to ticket #`number`, or returns null when it should become a new
 * ticket instead (no such ticket in this tenant, or the sender isn't its customer). A reply to a
 * pending, resolved or closed ticket moves it back to open: the customer is waiting again.
 */
export async function addEmailReplyToTicket(
  db: AnyDatabase,
  tenantId: string,
  reply: {
    number: number;
    fromEmail: string;
    body: string;
    inboundMessageId: string | null;
    requestId?: string;
    apiKeyId?: string;
  },
): Promise<ThreadResult | null> {
  const [ticket] = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.tenantId, tenantId), eq(tickets.number, reply.number)));
  if (!ticket) return null;
  if (ticket.customerEmail.toLowerCase() !== reply.fromEmail.toLowerCase()) {
    logger.warn(
      { ticketId: ticket.id, requestId: reply.requestId },
      "email names a ticket but comes from a different sender; creating a new ticket",
    );
    return null;
  }

  const findReplay = async () => {
    if (!reply.inboundMessageId) return null;
    const [row] = await db
      .select({ id: ticketMessages.id })
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.tenantId, tenantId),
          eq(ticketMessages.inboundMessageId, reply.inboundMessageId),
        ),
      );
    return row ? { ticket, replayed: true } : null;
  };
  const replay = await findReplay();
  if (replay) return replay;

  try {
    return await db.transaction(async (tx) => {
      const [message] = await tx
        .insert(ticketMessages)
        .values({
          tenantId,
          ticketId: ticket.id,
          authorType: "customer",
          body: stripQuotedReply(reply.body),
          inboundMessageId: reply.inboundMessageId,
        })
        .returning({ id: ticketMessages.id });
      const reopen = ticket.status !== "open";
      const [updated] = await tx
        .update(tickets)
        .set({
          status: "open",
          resolvedAt: reopen ? null : ticket.resolvedAt,
          updatedAt: sql`now()`,
        })
        .where(and(eq(tickets.id, ticket.id), eq(tickets.tenantId, tenantId)))
        .returning();
      await recordAudit(
        {
          tenantId,
          actorId: null,
          action: "ticket.customer_replied",
          entityType: "ticket",
          entityId: ticket.id,
          metadata: {
            source: "email",
            messageId: message.id,
            ...(reopen && { status: { from: ticket.status, to: "open" } }),
            ...(reply.apiKeyId && { apiKeyId: reply.apiKeyId }),
          },
          requestId: reply.requestId,
        },
        tx,
      );
      return { ticket: updated, replayed: false };
    });
  } catch (error) {
    // Two deliveries of the same email raced: the unique (tenant, message id) let one in.
    const winner = await findReplay();
    if (winner) return winner;
    throw error;
  }
}
