import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { incidents, tickets } from "@/db/schema";
import { incidentSeverity, incidentStatus } from "@/db/schema/enums";
import type { AnyDatabase } from "@/db/types";
import { AppError } from "@/lib/errors";
import { recordAudit } from "./audit";

/*
 * Incidents group the tickets caused by one operational problem (an outage, a bad deploy) so
 * they can be handled together. Tickets point at an incident through `tickets.incident_id`.
 */

export const INCIDENT_STATUSES = incidentStatus.enumValues;
export const INCIDENT_SEVERITIES = incidentSeverity.enumValues;

const idSchema = z.uuid();
const summarySchema = z
  .string()
  .trim()
  .max(5000)
  // Nullable so already-parsed input (from a form action) can be passed through again.
  .nullable()
  .transform((v) => v || null);

export const createIncidentSchema = z.object({
  title: z.string().trim().min(1, "Give the incident a title").max(200),
  severity: z.enum(INCIDENT_SEVERITIES),
  summary: summarySchema.optional(),
});

export const updateIncidentSchema = z
  .object({
    status: z.enum(INCIDENT_STATUSES).optional(),
    severity: z.enum(INCIDENT_SEVERITIES).optional(),
    summary: summarySchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to update");

export const linkTicketSchema = z.object({
  ticketNumber: z.coerce
    .number({ error: "Enter a ticket number" })
    .int("Enter a ticket number")
    .positive("Enter a ticket number"),
});

function parseId(id: string) {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) throw new AppError("NOT_FOUND", "Incident not found");
  return parsed.data;
}

/** Active incidents first, newest first within each group, with linked ticket counts. */
export async function listIncidents(db: AnyDatabase, tenantId: string) {
  const rows = await db
    .select({
      id: incidents.id,
      title: incidents.title,
      status: incidents.status,
      severity: incidents.severity,
      externalRef: incidents.externalRef,
      startedAt: incidents.startedAt,
      resolvedAt: incidents.resolvedAt,
      ticketCount: count(tickets.id),
      openTicketCount:
        sql<number>`count(${tickets.id}) filter (where ${inArray(tickets.status, ["open", "pending"])})`.mapWith(
          Number,
        ),
    })
    .from(incidents)
    .leftJoin(
      tickets,
      and(eq(tickets.incidentId, incidents.id), eq(tickets.tenantId, incidents.tenantId)),
    )
    .where(eq(incidents.tenantId, tenantId))
    .groupBy(incidents.id)
    .orderBy(sql`${incidents.status} = 'resolved'`, desc(incidents.startedAt));
  return rows.map(({ externalRef, ...rest }) => ({ ...rest, isDemo: externalRef !== null }));
}

export async function getIncident(db: AnyDatabase, tenantId: string, incidentId: string) {
  const id = parseId(incidentId);
  const [incident] = await db
    .select()
    .from(incidents)
    .where(and(eq(incidents.id, id), eq(incidents.tenantId, tenantId)));
  if (!incident) throw new AppError("NOT_FOUND", "Incident not found");

  const linked = await db
    .select({
      id: tickets.id,
      number: tickets.number,
      subject: tickets.subject,
      status: tickets.status,
      priority: tickets.priority,
      customerName: tickets.customerName,
      createdAt: tickets.createdAt,
    })
    .from(tickets)
    .where(and(eq(tickets.incidentId, id), eq(tickets.tenantId, tenantId)))
    .orderBy(desc(tickets.createdAt))
    .limit(200);

  const { externalRef, ...rest } = incident;
  return { ...rest, isDemo: externalRef !== null, tickets: linked };
}

interface Actor {
  tenantId: string;
  actorId: string;
}

export async function createIncident(
  db: AnyDatabase,
  { tenantId, actorId }: Actor,
  input: z.input<typeof createIncidentSchema>,
) {
  const data = createIncidentSchema.parse(input);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(incidents)
      .values({
        tenantId,
        title: data.title,
        severity: data.severity,
        summary: data.summary ?? null,
        startedAt: new Date(),
      })
      .returning({ id: incidents.id });
    await recordAudit(
      {
        tenantId,
        actorId,
        action: "incident.created",
        entityType: "incident",
        entityId: row.id,
        metadata: { severity: data.severity },
      },
      tx,
    );
    return row;
  });
}

/** Resolving stamps `resolved_at`; reopening clears it. Returns whether anything changed. */
export async function updateIncident(
  db: AnyDatabase,
  { tenantId, actorId, incidentId }: Actor & { incidentId: string },
  input: z.input<typeof updateIncidentSchema>,
) {
  const id = parseId(incidentId);
  const data = updateIncidentSchema.parse(input);
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(incidents)
      .where(and(eq(incidents.id, id), eq(incidents.tenantId, tenantId)))
      .for("update");
    if (!current) throw new AppError("NOT_FOUND", "Incident not found");

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const set: Partial<typeof incidents.$inferInsert> = {};
    if (data.status && data.status !== current.status) {
      changes.status = { from: current.status, to: data.status };
      set.status = data.status;
      set.resolvedAt = data.status === "resolved" ? new Date() : null;
    }
    if (data.severity && data.severity !== current.severity) {
      changes.severity = { from: current.severity, to: data.severity };
      set.severity = data.severity;
    }
    if (data.summary !== undefined && data.summary !== current.summary) {
      changes.summary = { from: current.summary !== null, to: data.summary !== null };
      set.summary = data.summary;
    }
    if (Object.keys(changes).length === 0) return { changed: false };

    await tx
      .update(incidents)
      .set(set)
      .where(and(eq(incidents.id, id), eq(incidents.tenantId, tenantId)));
    await recordAudit(
      {
        tenantId,
        actorId,
        action: "incident.updated",
        entityType: "incident",
        entityId: id,
        // Summary text stays out of the audit log; only whether it was set is recorded.
        metadata: changes,
      },
      tx,
    );
    return { changed: true };
  });
}

/** Links a ticket (by its visible number) to the incident, moving it from any other incident. */
export async function linkTicket(
  db: AnyDatabase,
  { tenantId, actorId, incidentId }: Actor & { incidentId: string },
  input: z.input<typeof linkTicketSchema>,
) {
  const id = parseId(incidentId);
  const { ticketNumber } = linkTicketSchema.parse(input);
  return db.transaction(async (tx) => {
    const [incident] = await tx
      .select({ id: incidents.id })
      .from(incidents)
      .where(and(eq(incidents.id, id), eq(incidents.tenantId, tenantId)));
    if (!incident) throw new AppError("NOT_FOUND", "Incident not found");
    const [ticket] = await tx
      .select({ id: tickets.id, incidentId: tickets.incidentId })
      .from(tickets)
      .where(and(eq(tickets.number, ticketNumber), eq(tickets.tenantId, tenantId)));
    if (!ticket) throw new AppError("NOT_FOUND", `Ticket #${ticketNumber} not found`);
    if (ticket.incidentId === id) return { ticketId: ticket.id, changed: false };

    await tx
      .update(tickets)
      .set({ incidentId: id })
      .where(and(eq(tickets.id, ticket.id), eq(tickets.tenantId, tenantId)));
    await recordAudit(
      {
        tenantId,
        actorId,
        action: "ticket.incident_linked",
        entityType: "ticket",
        entityId: ticket.id,
        metadata: { incidentId: id, previousIncidentId: ticket.incidentId },
      },
      tx,
    );
    return { ticketId: ticket.id, changed: true };
  });
}

export async function unlinkTicket(
  db: AnyDatabase,
  { tenantId, actorId, incidentId }: Actor & { incidentId: string },
  { ticketId }: { ticketId: string },
) {
  const id = parseId(incidentId);
  if (!idSchema.safeParse(ticketId).success) throw new AppError("NOT_FOUND", "Ticket not found");
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(tickets)
      .set({ incidentId: null })
      .where(
        and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId), eq(tickets.incidentId, id)),
      )
      .returning({ id: tickets.id });
    if (!row) throw new AppError("NOT_FOUND", "Ticket is not linked to this incident");
    await recordAudit(
      {
        tenantId,
        actorId,
        action: "ticket.incident_unlinked",
        entityType: "ticket",
        entityId: ticketId,
        metadata: { incidentId: id },
      },
      tx,
    );
  });
}
