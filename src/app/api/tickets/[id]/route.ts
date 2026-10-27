import { connection } from "next/server";
import { getDb } from "@/db/client";
import { parseJsonBody, withApiHandler } from "@/lib/api/handler";
import { requireApiPermission } from "@/server/auth/api-auth";
import { ticketSla } from "@/server/sla";
import { getTicket, updateTicket, updateTicketSchema } from "@/server/tickets";

/**
 * GET /api/tickets/{id}: the ticket, its conversation (internal notes carry `internal: true`) and
 * its SLA clocks at the time of the request.
 */
export const GET = withApiHandler<{ id: string }>(async (request, { params }) => {
  await connection();
  const db = getDb();
  const { tenantId } = await requireApiPermission(db, request, "ticket:read");
  const ticket = await getTicket(db, tenantId, params.id);
  return Response.json(
    { ticket, sla: ticketSla(ticket, new Date()) },
    { headers: { "cache-control": "no-store" } },
  );
});

/** PATCH /api/tickets/{id}: change `status` and/or `assigneeId` (null unassigns). */
export const PATCH = withApiHandler<{ id: string }>(async (request, { params }) => {
  const db = getDb();
  const { tenantId, actor } = await requireApiPermission(db, request, "ticket:write");
  const input = await parseJsonBody(request, updateTicketSchema);
  const { changed } = await updateTicket(db, { tenantId, ticketId: params.id, actor }, input);
  const ticket = await getTicket(db, tenantId, params.id);
  return Response.json({
    changed,
    ticket: { id: ticket.id, status: ticket.status, assigneeId: ticket.assigneeId },
  });
});
