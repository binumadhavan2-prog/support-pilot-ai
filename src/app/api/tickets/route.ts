import { connection } from "next/server";
import { getDb } from "@/db/client";
import { parseJsonBody, withApiHandler } from "@/lib/api/handler";
import { requireApiPermission } from "@/server/auth/api-auth";
import { createdResponse, readIdempotencyKey } from "./idempotency";
import {
  createTicket,
  createTicketSchema,
  listTickets,
  listTicketsQuerySchema,
  searchParamsToObject,
} from "@/server/tickets";

/** GET /api/tickets?status=&priority=&category=&assignee=&search=&page=&pageSize= */
export const GET = withApiHandler(async (request) => {
  await connection();
  const db = getDb();
  const { tenantId, actor } = await requireApiPermission(db, request, "ticket:read");
  const query = listTicketsQuerySchema.parse(
    searchParamsToObject(new URL(request.url).searchParams),
  );
  return Response.json(
    await listTickets(db, tenantId, query, {
      // "assignee=me" means the signed-in user; an API key has no "me".
      viewerId: actor.type === "user" ? actor.userId : undefined,
    }),
    {
      headers: { "cache-control": "no-store" },
    },
  );
});

/** POST /api/tickets: create a ticket from a JSON webhook payload. */
export const POST = withApiHandler(async (request, { requestId }) => {
  const db = getDb();
  const { tenantId, actor } = await requireApiPermission(db, request, "ticket:write");
  const idempotencyKey = readIdempotencyKey(request);
  const input = await parseJsonBody(request, createTicketSchema);
  const ticket = await createTicket(db, tenantId, input, {
    actor,
    source: "api",
    requestId,
    idempotencyKey,
  });
  return createdResponse(ticket);
});
