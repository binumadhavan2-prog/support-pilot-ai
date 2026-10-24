import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sameTenantCascade, tenantId } from "./tenancy";

/*
 * The tenant's own customers and their invoices. In a real deployment these would be synced from
 * the tenant's billing system; the AI's tools (look up account, look up order, propose refund)
 * read them. In this project they are populated only by the labeled demo seed.
 */

export const customerAccounts = pgTable(
  "customer_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    // The id in the tenant's own system, e.g. "ACC-1042".
    externalRef: text("external_ref").notNull(),
    companyName: text("company_name").notNull(),
    contactName: text("contact_name").notNull(),
    contactEmail: text("contact_email").notNull(),
    plan: text("plan").notNull(),
    // e.g. active, trialing, past_due, canceled. Free text: it mirrors the source system.
    status: text("status").notNull(),
    mrrCents: integer("mrr_cents").notNull().default(0),
    currency: text("currency").notNull().default("USD"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("customer_accounts_tenant_ref_uq").on(t.tenantId, t.externalRef),
    unique("customer_accounts_id_tenant_uq").on(t.id, t.tenantId),
    index("customer_accounts_tenant_email_idx").on(t.tenantId, t.contactEmail),
    check("customer_accounts_mrr_nonnegative", sql`${t.mrrCents} >= 0`),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    accountId: uuid("account_id").notNull(),
    // Invoice / order id in the tenant's billing system, e.g. "INV-20931".
    externalRef: text("external_ref").notNull(),
    description: text("description").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    // e.g. paid, pending, failed, refunded.
    status: text("status").notNull(),
    orderedAt: timestamp("ordered_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("orders_tenant_ref_uq").on(t.tenantId, t.externalRef),
    index("orders_account_idx").on(t.accountId, t.orderedAt.desc()),
    sameTenantCascade(
      "orders_account_same_tenant_fk",
      [t.accountId, t.tenantId],
      [customerAccounts.id, customerAccounts.tenantId],
    ),
    check("orders_amount_nonnegative", sql`${t.amountCents} >= 0`),
  ],
);
