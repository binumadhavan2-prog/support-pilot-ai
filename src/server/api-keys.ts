import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { apiKeys } from "@/db/schema";
import type { AnyDatabase } from "@/db/types";
import type { Permission } from "./auth/permissions";

const KEY_PREFIX = "sp_";
const keyFormat = /^sp_[A-Za-z0-9_-]{43}$/;

/**
 * What an integration key may do. Fixed rather than per-key until a phase needs finer scopes:
 * webhooks create tickets and read them back.
 */
export const API_KEY_PERMISSIONS: readonly Permission[] = ["ticket:read", "ticket:write"];

export const apiKeyNameSchema = z.string().trim().min(1).max(100);

function hashKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

/** Creates a key and returns the plain value. It is not stored, so it cannot be shown again. */
export async function createApiKey(
  db: AnyDatabase,
  input: { tenantId: string; name: string; createdById?: string | null },
) {
  const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const [row] = await db
    .insert(apiKeys)
    .values({
      tenantId: input.tenantId,
      name: apiKeyNameSchema.parse(input.name),
      prefix: key.slice(0, 10),
      keyHash: hashKey(key),
      createdById: input.createdById ?? null,
    })
    .returning({ id: apiKeys.id, prefix: apiKeys.prefix });
  return { ...row, key };
}

/**
 * Resolves a presented key to its tenant, or null if it is unknown, malformed or revoked.
 * Lookup is by hash, so the plain key never reaches a query or a log.
 */
export async function verifyApiKey(db: AnyDatabase, key: string) {
  if (!keyFormat.test(key)) return null;
  const [row] = await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(apiKeys.keyHash, hashKey(key)), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id, tenantId: apiKeys.tenantId });
  return row ?? null;
}

export async function revokeApiKey(db: AnyDatabase, tenantId: string, id: string) {
  const [row] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.tenantId, tenantId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return Boolean(row);
}
