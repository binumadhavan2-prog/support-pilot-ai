import { and, asc, count, desc, eq, ilike, inArray, isNull, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { incidents, ticketMessages, tickets, triageResults, user } from "@/db/schema";
import { ticketCategory, ticketPriority, ticketStatus } from "@/db/schema/enums";
import type { AnyDatabase } from "@/db/types";
import { AppError } from "@/lib/errors";
import { recordAudit } from "./audit";
import { planReplyEmail, queueReplyEmail } from "./email/outbound";
import { enqueueJob } from "./jobs";
import { slaAtRiskSql, slaOverdueSql } from "./sla";

export const TICKET_STATUSES = ticketStatus.enumValues;
export const TICKET_PRIORITIES = ticketPriority.enumValues;
export const TICKET_CATEGORIES = ticketCategory.enumValues;

// Generous for a support message, small enough that one request cannot bloat the database.
const MAX_BODY_LENGTH = 50_000;

export const createTicketSchema = z.object({
  subject: z.string().trim().min(1, "Subject is required").max(300),
  body: z.string().trim().min(1, "Body is required").max(MAX_BODY_LENGTH),
  customer: z.object({
    name: z.string().trim().min(1).max(200),
    email: z
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
  }),
  priority: z.enum(TICKET_PRIORITIES).optional(),
});

export type CreateTicketInput = z.infer<typeof createTicketSchema>;

/** `Idempotency-Key` header or email Message-ID: printable, at most 200 characters. */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[!-~]+$/, "Idempotency-Key must be printable ASCII without spaces");

/** Who caused a change, for the audit log. API keys have no user id. */
export type Actor = { type: "user"; userId: string } | { type: "api_key"; apiKeyId: string };

/**
 * Creates a ticket with its first customer message, records the audit event and queues AI triage,
 * all in one transaction: a ticket never exists without its triage job, or the reverse.
 */
export async function createTicket(
  db: AnyDatabase,
  tenantId: string,
  input: CreateTicketInput,
  {
    actor,
    source,
    requestId,
    idempotencyKey,
  }: { actor: Actor; source: "api" | "email"; requestId?: string; idempotencyKey?: string },
) {
  const findExisting = async () => {
    if (!idempotencyKey) return undefined;
    const [row] = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.tenantId, tenantId), eq(tickets.idempotencyKey, idempotencyKey)));
    return row;
  };
  // A retried delivery with the same key gets the ticket the first one created.
  const existing = await findExisting();
  if (existing) return { ...existing, replayed: true };

  try {
    const created = await insertTicket();
    return { ...created, replayed: false };
  } catch (error) {
    // Two deliveries raced past the check: the unique (tenant, key) constraint let one win.
    const winner = await findExisting();
    if (winner) return { ...winner, replayed: true };
    throw error;
  }

  async function insertTicket() {
    return db.transaction(async (tx) => {
      const [ticket] = await tx
        .insert(tickets)
        .values({
          tenantId,
          subject: input.subject,
          customerName: input.customer.name,
          customerEmail: input.customer.email,
          priority: input.priority,
          idempotencyKey,
        })
        .returning();
      await tx.insert(ticketMessages).values({
        tenantId,
        ticketId: ticket.id,
        authorType: "customer",
        body: input.body,
      });
      await recordAudit(
        {
          tenantId,
          actorId: actor.type === "user" ? actor.userId : null,
          action: "ticket.created",
          entityType: "ticket",
          entityId: ticket.id,
          metadata: {
            source,
            number: ticket.number,
            ...(actor.type === "api_key" && { apiKeyId: actor.apiKeyId }),
          },
          requestId,
        },
        tx,
      );
      await enqueueJob(tx, { tenantId, type: "triage_ticket", payload: { ticketId: ticket.id } });
      return ticket;
    });
  }
}

export const listTicketsQuerySchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  sla: z.enum(["overdue", "at_risk"]).optional(),
  search: z.string().trim().max(200).optional(),
  // "me", "unassigned", or a user id.
  assignee: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListTicketsQuery = z.infer<typeof listTicketsQuerySchema>;

/** Turns `?a=1&b=` into `{ a: "1" }`, so empty filter fields mean "any". */
export function searchParamsToObject(params: URLSearchParams | Record<string, unknown>) {
  const entries =
    params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params);
  return Object.fromEntries(entries.filter(([, v]) => typeof v === "string" && v.trim() !== ""));
}

/** `%`, `_` and `\` are wildcards in LIKE; escape them so a search matches literally. */
function likePattern(term: string) {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function listTickets(
  db: AnyDatabase,
  tenantId: string,
  query: ListTicketsQuery,
  { viewerId }: { viewerId?: string } = {},
) {
  const conditions: SQL[] = [eq(tickets.tenantId, tenantId)];
  if (query.status) conditions.push(eq(tickets.status, query.status));
  if (query.assignee === "unassigned") conditions.push(isNull(tickets.assigneeId));
  else if (query.assignee === "me") conditions.push(eq(tickets.assigneeId, viewerId ?? ""));
  else if (query.assignee) conditions.push(eq(tickets.assigneeId, query.assignee));
  if (query.priority) conditions.push(eq(tickets.priority, query.priority));
  if (query.category) conditions.push(eq(tickets.category, query.category));
  if (query.sla === "overdue") conditions.push(slaOverdueSql);
  if (query.sla === "at_risk") conditions.push(slaAtRiskSql);
  if (query.search) {
    const pattern = likePattern(query.search);
    const matches = [
      ilike(tickets.subject, pattern),
      ilike(tickets.customerName, pattern),
      ilike(tickets.customerEmail, pattern),
    ];
    // "#1042" or "1042" finds the ticket by number.
    const number = /^#?(\d{1,9})$/.exec(query.search)?.[1];
    if (number) matches.push(eq(tickets.number, Number(number)));
    conditions.push(or(...matches)!);
  }
  const where = and(...conditions);

  const [items, [{ total }]] = await Promise.all([
    db
      .select({
        id: tickets.id,
        number: tickets.number,
        subject: tickets.subject,
        customerName: tickets.customerName,
        customerEmail: tickets.customerEmail,
        status: tickets.status,
        priority: tickets.priority,
        category: tickets.category,
        team: tickets.team,
        injectionFlagged: tickets.injectionFlagged,
        assigneeId: tickets.assigneeId,
        assigneeName: user.name,
        isDemo: tickets.externalRef,
        firstResponseAt: tickets.firstResponseAt,
        resolvedAt: tickets.resolvedAt,
        createdAt: tickets.createdAt,
      })
      .from(tickets)
      .leftJoin(user, eq(user.id, tickets.assigneeId))
      .where(where)
      .orderBy(desc(tickets.createdAt), desc(tickets.number))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ total: count() }).from(tickets).where(where),
  ]);

  return {
    // Seed rows carry an external_ref; the UI labels them as demo data.
    items: items.map(({ isDemo, ...item }) => ({ ...item, isDemo: isDemo !== null })),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

export const ticketIdSchema = z.uuid({ error: "Ticket not found" });

/**
 * One ticket with its conversation. A ticket in another tenant gets the same NOT_FOUND as a
 * missing one, so ids cannot be probed across tenants.
 */
export async function getTicket(db: AnyDatabase, tenantId: string, ticketId: string) {
  const id = ticketIdSchema.safeParse(ticketId);
  if (!id.success) throw new AppError("NOT_FOUND", "Ticket not found");

  const [ticket] = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.id, id.data), eq(tickets.tenantId, tenantId)));
  if (!ticket) throw new AppError("NOT_FOUND", "Ticket not found");

  const messages = await db
    .select({
      id: ticketMessages.id,
      authorType: ticketMessages.authorType,
      authorId: ticketMessages.authorId,
      authorName: user.name,
      body: ticketMessages.body,
      sourceDraftId: ticketMessages.sourceDraftId,
      internal: ticketMessages.internal,
      emailStatus: ticketMessages.emailStatus,
      emailDetail: ticketMessages.emailDetail,
      emailSentAt: ticketMessages.emailSentAt,
      createdAt: ticketMessages.createdAt,
    })
    .from(ticketMessages)
    .leftJoin(user, eq(user.id, ticketMessages.authorId))
    .where(and(eq(ticketMessages.ticketId, ticket.id), eq(ticketMessages.tenantId, tenantId)))
    .orderBy(asc(ticketMessages.createdAt), asc(ticketMessages.id));

  // Latest AI triage pass, if any (history is kept; re-triage adds rows).
  const [triage] = await db
    .select({
      category: triageResults.category,
      priority: triageResults.priority,
      sentiment: triageResults.sentiment,
      language: triageResults.language,
      summary: triageResults.summary,
      suggestedTeam: triageResults.suggestedTeam,
      isInjection: triageResults.isInjection,
      confidence: triageResults.confidence,
      reasoning: triageResults.reasoning,
      model: triageResults.model,
      createdAt: triageResults.createdAt,
    })
    .from(triageResults)
    .where(and(eq(triageResults.ticketId, ticket.id), eq(triageResults.tenantId, tenantId)))
    .orderBy(desc(triageResults.createdAt))
    .limit(1);

  const [incident] = ticket.incidentId
    ? await db
        .select({ id: incidents.id, title: incidents.title, status: incidents.status })
        .from(incidents)
        .where(and(eq(incidents.id, ticket.incidentId), eq(incidents.tenantId, tenantId)))
    : [];

  const { externalRef, ...rest } = ticket;
  return {
    ...rest,
    isDemo: externalRef !== null,
    messages,
    triage: triage ?? null,
    incident: incident ?? null,
  };
}

/** Agents and admins of the tenant who can own tickets (banned users excluded). */
export async function listAssignableUsers(db: AnyDatabase, tenantId: string) {
  return db
    .select({ id: user.id, name: user.name, role: user.role })
    .from(user)
    .where(
      and(
        eq(user.tenantId, tenantId),
        inArray(user.role, ["admin", "agent"]),
        eq(user.banned, false),
      ),
    )
    .orderBy(asc(user.name));
}

export const updateTicketSchema = z
  .object({
    status: z.enum(TICKET_STATUSES).optional(),
    // null unassigns.
    assigneeId: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.assigneeId !== undefined, {
    message: "Nothing to change",
  });

export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;

/**
 * Changes a ticket's status and/or assignee. The assignee must be an active agent or admin in
 * the same tenant. Resolving or closing stamps `resolved_at`; reopening clears it. Each change is
 * audited with its before and after values.
 */
export async function updateTicket(
  db: AnyDatabase,
  { tenantId, ticketId, actor }: { tenantId: string; ticketId: string; actor: Actor },
  input: UpdateTicketInput,
) {
  if (!ticketIdSchema.safeParse(ticketId).success)
    throw new AppError("NOT_FOUND", "Ticket not found");
  return db.transaction(async (tx) => {
    const [ticket] = await tx
      .select({
        status: tickets.status,
        assigneeId: tickets.assigneeId,
        resolvedAt: tickets.resolvedAt,
      })
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId)));
    if (!ticket) throw new AppError("NOT_FOUND", "Ticket not found");

    if (input.assigneeId) {
      const [assignee] = await tx
        .select({ id: user.id })
        .from(user)
        .where(
          and(
            eq(user.id, input.assigneeId),
            eq(user.tenantId, tenantId),
            inArray(user.role, ["admin", "agent"]),
            eq(user.banned, false),
          ),
        );
      // Same message for a missing user and one in another tenant: ids can't be probed.
      if (!assignee)
        throw new AppError("VALIDATION_ERROR", "Choose an agent or admin in your team");
    }

    const changes: Partial<typeof tickets.$inferInsert> = {};
    const audit: Record<string, unknown> = {};
    if (input.status !== undefined && input.status !== ticket.status) {
      changes.status = input.status;
      const done = input.status === "resolved" || input.status === "closed";
      changes.resolvedAt = done ? (ticket.resolvedAt ?? new Date()) : null;
      audit.status = { from: ticket.status, to: input.status };
    }
    if (input.assigneeId !== undefined && input.assigneeId !== ticket.assigneeId) {
      changes.assigneeId = input.assigneeId;
      audit.assigneeId = { from: ticket.assigneeId, to: input.assigneeId };
    }
    if (Object.keys(changes).length === 0) return { changed: false };

    await tx
      .update(tickets)
      .set(changes)
      .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId)));
    await recordAudit(
      {
        tenantId,
        actorId: actor.type === "user" ? actor.userId : null,
        action: "ticket.updated",
        entityType: "ticket",
        entityId: ticketId,
        metadata: { ...audit, ...(actor.type === "api_key" && { apiKeyId: actor.apiKeyId }) },
      },
      tx,
    );
    return { changed: true };
  });
}

export const replySchema = z.object({
  body: z.string().trim().min(1, "Write a reply first").max(MAX_BODY_LENGTH),
});

/**
 * An agent's own reply (not from an AI draft). Like an approved draft, it records the first
 * response time and moves an open ticket to pending (waiting on the customer).
 */
export async function addAgentReply(
  db: AnyDatabase,
  { tenantId, ticketId, authorId }: { tenantId: string; ticketId: string; authorId: string },
  input: { body: string },
  { emailEnabled = false }: { emailEnabled?: boolean } = {},
) {
  const { body } = replySchema.parse(input);
  if (!ticketIdSchema.safeParse(ticketId).success)
    throw new AppError("NOT_FOUND", "Ticket not found");
  return db.transaction(async (tx) => {
    const [ticket] = await tx
      .select({
        status: tickets.status,
        firstResponseAt: tickets.firstResponseAt,
        customerEmail: tickets.customerEmail,
        externalRef: tickets.externalRef,
      })
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId)));
    if (!ticket) throw new AppError("NOT_FOUND", "Ticket not found");
    const plan = planReplyEmail(ticket, { enabled: emailEnabled });
    const [message] = await tx
      .insert(ticketMessages)
      .values({ tenantId, ticketId, authorType: "agent", authorId, body, ...plan })
      .returning({ id: ticketMessages.id, emailStatus: ticketMessages.emailStatus });
    await queueReplyEmail(tx, { tenantId, messageId: message.id, plan });
    await tx
      .update(tickets)
      .set({
        firstResponseAt: ticket.firstResponseAt ?? new Date(),
        status: ticket.status === "open" ? "pending" : ticket.status,
      })
      .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId)));
    await recordAudit(
      {
        tenantId,
        actorId: authorId,
        action: "ticket.replied",
        entityType: "ticket",
        entityId: ticketId,
        metadata: { messageId: message.id, length: body.length },
      },
      tx,
    );
    return message;
  });
}

/**
 * A note for the team, never the customer: it is not emailed, doesn't count as the first
 * response, doesn't change the status, and is never sent to a model. The audit row records its
 * length only, not the text.
 */
export async function addInternalNote(
  db: AnyDatabase,
  { tenantId, ticketId, authorId }: { tenantId: string; ticketId: string; authorId: string },
  input: { body: string },
) {
  const { body } = replySchema.parse(input);
  if (!ticketIdSchema.safeParse(ticketId).success)
    throw new AppError("NOT_FOUND", "Ticket not found");
  return db.transaction(async (tx) => {
    const [ticket] = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId)));
    if (!ticket) throw new AppError("NOT_FOUND", "Ticket not found");
    const [note] = await tx
      .insert(ticketMessages)
      .values({ tenantId, ticketId, authorType: "agent", authorId, body, internal: true })
      .returning({ id: ticketMessages.id });
    await recordAudit(
      {
        tenantId,
        actorId: authorId,
        action: "ticket.note_added",
        entityType: "ticket",
        entityId: ticketId,
        metadata: { messageId: note.id, length: body.length },
      },
      tx,
    );
    return note;
  });
}
