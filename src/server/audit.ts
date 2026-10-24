import "server-only";
import { getDb } from "@/db/client";
import { auditLogs } from "@/db/schema";
import type { AnyDatabase } from "@/db/types";
import { logger } from "@/lib/logger";

export interface AuditEvent {
  tenantId: string;
  actorId: string | null;
  /** Dotted verb, e.g. "user.created", "auth.signed_in". */
  action: string;
  entityType: string;
  entityId: string;
  /** Business context only. Never secrets, passwords or tokens. */
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  requestId?: string | null;
}

type Executor = Pick<AnyDatabase, "insert">;

/** Pass a transaction as `executor` to make the audit row atomic with the change it records. */
export async function recordAudit(event: AuditEvent, executor: Executor = getDb()) {
  await executor.insert(auditLogs).values({
    tenantId: event.tenantId,
    actorId: event.actorId,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    metadata: event.metadata ?? {},
    ipAddress: event.ipAddress ?? null,
    requestId: event.requestId ?? null,
  });
  logger.info(
    {
      audit: {
        tenantId: event.tenantId,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
      },
    },
    "audit event",
  );
}

/** Best-effort client IP from proxy headers (first hop). Informational only, never trust it for auth. */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip") || null;
}
