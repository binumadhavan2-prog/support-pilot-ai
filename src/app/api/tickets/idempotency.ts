import { AppError } from "@/lib/errors";
import { idempotencyKeySchema } from "@/server/tickets";

/** The optional `Idempotency-Key` header, validated. */
export function readIdempotencyKey(request: Request): string | undefined {
  const header = request.headers.get("idempotency-key");
  if (header === null) return undefined;
  const parsed = idempotencyKeySchema.safeParse(header);
  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "Idempotency-Key must be 1-200 printable characters");
  }
  return parsed.data;
}

/** 201 for a new ticket; 200 with `Idempotent-Replayed: true` when a retry matched an earlier one. */
export function createdResponse(ticket: {
  id: string;
  number: number;
  status: string;
  replayed: boolean;
}) {
  return Response.json(
    { ticket: { id: ticket.id, number: ticket.number, status: ticket.status } },
    {
      status: ticket.replayed ? 200 : 201,
      headers: {
        location: `/api/tickets/${ticket.id}`,
        ...(ticket.replayed && { "idempotent-replayed": "true" }),
      },
    },
  );
}
