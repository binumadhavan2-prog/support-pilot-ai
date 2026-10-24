import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgTable,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * A customer organization. Every business row carries a `tenant_id`, and every query is scoped by
 * the signed-in user's tenant.
 *
 * Isolation is enforced twice: the service layer filters by tenant, and composite foreign keys
 * (`(child.parent_id, child.tenant_id) -> parent(id, tenant_id)`) make it impossible for the
 * database to link rows from two different tenants, even if a query forgets the filter.
 */
export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // URL-safe identifier, e.g. "acme". Lower-case letters, digits and hyphens.
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("tenants_slug_format", sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{1,62}$'`)],
);

/**
 * `tenant_id` column for business tables. `restrict`: a tenant cannot be deleted while it still
 * owns data, so removing one is a deliberate, explicit cleanup.
 */
export const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "restrict" });

type Cols = [AnyPgColumn, AnyPgColumn];

/** Same-tenant reference that deletes the child with its parent. */
export function sameTenantCascade(name: string, columns: Cols, foreignColumns: Cols) {
  return foreignKey({ name, columns, foreignColumns }).onDelete("cascade");
}

/**
 * Same-tenant check for a nullable reference that is cleared (not cascaded) when the parent is
 * deleted. Pair it with a single-column `references(..., { onDelete: "set null" })` on the
 * reference column: that FK clears the id; this one (NO ACTION, checked at the end of the
 * statement) only enforces the tenant match. A composite `SET NULL` would also null `tenant_id`.
 */
export function sameTenantCheck(name: string, columns: Cols, foreignColumns: Cols) {
  return foreignKey({ name, columns, foreignColumns }).onDelete("no action");
}
