import { getDb } from "@/db/client";
import { withApiHandler } from "@/lib/api/handler";
import { AppError } from "@/lib/errors";
import { requireApiPermission } from "@/server/auth/api-auth";
import { addEmailReplyToTicket, ticketNumberFromSubject } from "@/server/email/threading";
import { MAX_RAW_EMAIL_BYTES, parseInboundEmail } from "@/server/inbound-email";
import { createTicket } from "@/server/tickets";
import { createdResponse, readIdempotencyKey } from "../idempotency";

/**
 * POST /api/tickets/email: a raw RFC 5322 email (the request body). A customer's reply to one of
 * our emails ("[#1042]" in the subject, sent by that ticket's customer) is added to the ticket;
 * anything else creates a new ticket.
 */
export const POST = withApiHandler(async (request, { requestId }) => {
  const db = getDb();
  const { tenantId, actor } = await requireApiPermission(db, request, "ticket:write");

  // Content-Length can be absent or wrong, so it is a fast path only; the read length is checked too.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_RAW_EMAIL_BYTES) throw tooLarge();
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_RAW_EMAIL_BYTES) throw tooLarge();
  if (!raw.trim()) throw new AppError("VALIDATION_ERROR", "Request body must be a raw email");

  const { input, messageId } = await parseInboundEmail(raw);

  const number = ticketNumberFromSubject(input.subject);
  if (number !== null) {
    const threaded = await addEmailReplyToTicket(db, tenantId, {
      number,
      fromEmail: input.customer.email,
      body: input.body,
      inboundMessageId: messageId,
      requestId,
      apiKeyId: actor.type === "api_key" ? actor.apiKeyId : undefined,
    });
    if (threaded) return threadedResponse(threaded);
  }

  const ticket = await createTicket(db, tenantId, input, {
    actor,
    source: "email",
    requestId,
    // An explicit header wins; otherwise the email's own Message-ID dedupes provider retries.
    idempotencyKey:
      readIdempotencyKey(request) ?? (messageId ? `message-id:${messageId}` : undefined),
  });
  return createdResponse(ticket);
});

const tooLarge = () =>
  new AppError("PAYLOAD_TOO_LARGE", `Email must be at most ${MAX_RAW_EMAIL_BYTES} bytes`);

/** 201 when the reply was added; 200 with `Idempotent-Replayed` when a retry matched it. */
function threadedResponse({
  ticket,
  replayed,
}: {
  ticket: { id: string; number: number; status: string };
  replayed: boolean;
}) {
  return Response.json(
    { ticket: { id: ticket.id, number: ticket.number, status: ticket.status }, threaded: true },
    {
      status: replayed ? 200 : 201,
      headers: {
        location: `/api/tickets/${ticket.id}`,
        ...(replayed && { "idempotent-replayed": "true" }),
      },
    },
  );
}
