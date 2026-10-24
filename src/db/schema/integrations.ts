import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { jobStatus } from "./enums";
import { sameTenantCheck, tenantId } from "./tenancy";

/**
 * Keys that let an external system (a helpdesk webhook, an inbound email service) call the API
 * for one tenant. Only a SHA-256 hash is stored; the plain key is shown once at creation.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    // First characters of the key, so admins can tell keys apart without seeing them.
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    createdById: text("created_by_id").references(() => user.id, { onDelete: "set null" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("api_keys_tenant_idx").on(t.tenantId),
    sameTenantCheck(
      "api_keys_creator_same_tenant_fk",
      [t.createdById, t.tenantId],
      [user.id, user.tenantId],
    ),
  ],
);

/**
 * Background work queue in Postgres (no Redis). Workers claim rows with SKIP LOCKED, so several
 * can run at once without taking the same job.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    // e.g. "triage_ticket". The payload shape is validated by the job's handler.
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    // Safe summary only (an AppError message or the error class), never upstream text.
    lastError: text("last_error"),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("jobs_status_run_after_idx").on(t.status, t.runAfter),
    index("jobs_tenant_created_idx").on(t.tenantId, t.createdAt.desc()),
  ],
);

/**
 * Fixed-window request counters for API rate limiting, kept in Postgres so limits survive restarts
 * and hold across instances. Infrastructure, not business data: the key already names the caller
 * (e.g. "api_key:<id>:write"), so there is no tenant column. Old windows are pruned as it runs.
 */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.key, t.windowStart] }),
    index("rate_limits_window_idx").on(t.windowStart),
  ],
);
