import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { customerAccounts } from "./customers";
import {
  messageAuthorType,
  supportTeam,
  ticketCategory,
  ticketPriority,
  ticketSentiment,
  ticketStatus,
} from "./enums";
import { incidents } from "./incidents";
import { sameTenantCascade, sameTenantCheck, tenantId } from "./tenancy";

export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    // Human-friendly ticket number shown in the UI (#1042). One sequence across tenants, so
    // numbers are unique but not contiguous within a tenant.
    number: integer("number").notNull().unique().generatedAlwaysAsIdentity({ startWith: 1000 }),
    // Id in an external helpdesk or dataset (e.g. the seed's "T-0042"). Unique per tenant.
    externalRef: text("external_ref"),
    // Caller-supplied key (Idempotency-Key header, or an email's Message-ID) so a retried webhook
    // returns the ticket it already created instead of making a duplicate. Unique per tenant.
    idempotencyKey: text("idempotency_key"),
    subject: text("subject").notNull(),
    customerName: text("customer_name").notNull(),
    customerEmail: text("customer_email").notNull(),
    customerAccountId: uuid("customer_account_id").references(() => customerAccounts.id, {
      onDelete: "set null",
    }),
    incidentId: uuid("incident_id").references(() => incidents.id, { onDelete: "set null" }),
    status: ticketStatus("status").notNull().default("open"),
    priority: ticketPriority("priority").notNull().default("normal"),
    // Latest triage output, denormalized for list views. Full history is in triage_results.
    category: ticketCategory("category"),
    sentiment: ticketSentiment("sentiment"),
    // Detected language, e.g. "en", "hinglish", "tanglish".
    language: text("language"),
    aiSummary: text("ai_summary"),
    classifiedAt: timestamp("classified_at", { withTimezone: true }),
    // Queue chosen by the routing rules after triage; null until triaged.
    team: supportTeam("team"),
    // Latest triage flagged prompt-injection text. The UI warns agents; AI output stays a draft.
    injectionFlagged: boolean("injection_flagged").notNull().default(false),
    assigneeId: text("assignee_id").references(() => user.id, { onDelete: "set null" }),
    firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("tickets_tenant_status_created_idx").on(t.tenantId, t.status, t.createdAt.desc()),
    index("tickets_tenant_created_idx").on(t.tenantId, t.createdAt.desc()),
    index("tickets_assignee_idx").on(t.assigneeId),
    index("tickets_incident_idx").on(t.incidentId),
    unique("tickets_tenant_ref_uq").on(t.tenantId, t.externalRef),
    unique("tickets_tenant_idempotency_uq").on(t.tenantId, t.idempotencyKey),
    unique("tickets_id_tenant_uq").on(t.id, t.tenantId),
    sameTenantCheck(
      "tickets_assignee_same_tenant_fk",
      [t.assigneeId, t.tenantId],
      [user.id, user.tenantId],
    ),
    sameTenantCheck(
      "tickets_account_same_tenant_fk",
      [t.customerAccountId, t.tenantId],
      [customerAccounts.id, customerAccounts.tenantId],
    ),
    sameTenantCheck(
      "tickets_incident_same_tenant_fk",
      [t.incidentId, t.tenantId],
      [incidents.id, incidents.tenantId],
    ),
    // Simple subject/customer search for the ticket list.
    index("tickets_search_idx").using(
      "gin",
      sql`to_tsvector('english', ${t.subject} || ' ' || ${t.customerName} || ' ' || ${t.customerEmail})`,
    ),
  ],
);

export const ticketMessages = pgTable(
  "ticket_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    ticketId: uuid("ticket_id").notNull(),
    authorType: messageAuthorType("author_type").notNull(),
    // Set for agent messages; customers are not users in this system.
    authorId: text("author_id").references(() => user.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    // Set when the message was sent from an approved AI draft (traceability for analytics).
    // Plain uuid (no FK) to avoid a circular reference with ai_drafts; enforced in the service layer.
    sourceDraftId: uuid("source_draft_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ticket_messages_ticket_created_idx").on(t.ticketId, t.createdAt),
    sameTenantCascade(
      "ticket_messages_ticket_same_tenant_fk",
      [t.ticketId, t.tenantId],
      [tickets.id, tickets.tenantId],
    ),
  ],
);
