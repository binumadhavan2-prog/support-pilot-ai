import { index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { incidentSeverity, incidentStatus } from "./enums";
import { tenantId } from "./tenancy";

/**
 * An operational problem affecting many customers (e.g. a payment-gateway outage). Related
 * tickets point to it via `tickets.incident_id`. `alert` and `logs` hold the evidence bundle
 * (monitoring alert payload and log excerpt) that the AI summarizes for responders.
 */
export const incidents = pgTable(
  "incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    externalRef: text("external_ref"),
    title: text("title").notNull(),
    status: incidentStatus("status").notNull().default("open"),
    severity: incidentSeverity("severity").notNull(),
    summary: text("summary"),
    alert: jsonb("alert").$type<Record<string, unknown>>(),
    logs: text("logs"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("incidents_tenant_status_idx").on(t.tenantId, t.status, t.startedAt.desc()),
    unique("incidents_tenant_ref_uq").on(t.tenantId, t.externalRef),
    unique("incidents_id_tenant_uq").on(t.id, t.tenantId),
  ],
);
