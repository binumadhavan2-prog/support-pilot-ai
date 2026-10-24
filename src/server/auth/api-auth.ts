import "server-only";
import type { AnyDatabase } from "@/db/types";
import { AppError } from "@/lib/errors";
import { API_KEY_PERMISSIONS, verifyApiKey } from "../api-keys";
import { API_RATE_LIMITS, consumeRateLimit } from "../rate-limit";
import type { Actor } from "../tickets";
import type { Permission } from "./permissions";
import { requirePermission } from "./session";

export interface ApiPrincipal {
  /** Every query in the handler must filter by this. Never taken from the request body. */
  tenantId: string;
  actor: Actor;
}

/**
 * Authenticates an API request. A `Bearer` API key (integrations, curl) takes precedence; without
 * one, the caller's session cookie is used with the normal role checks. A bad key is rejected
 * outright rather than falling back to the cookie, so a misconfigured integration fails loudly.
 */
export async function requireApiPermission(
  db: AnyDatabase,
  request: Request,
  permission: Permission,
): Promise<ApiPrincipal> {
  const principal = await authenticate(db, request, permission);
  // Limited per caller, after authentication: a flood with a stolen key or session is still
  // capped, and one tenant's integration can't exhaust another's budget.
  const bucket = permission.endsWith(":read") ? "read" : "write";
  const who =
    principal.actor.type === "api_key"
      ? `api_key:${principal.actor.apiKeyId}`
      : `user:${principal.actor.userId}`;
  await consumeRateLimit(db, `${who}:${bucket}`, API_RATE_LIMITS[bucket]);
  return principal;
}

async function authenticate(
  db: AnyDatabase,
  request: Request,
  permission: Permission,
): Promise<ApiPrincipal> {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const key = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
    const apiKey = key ? await verifyApiKey(db, key) : null;
    if (!apiKey) throw new AppError("UNAUTHENTICATED", "Invalid or revoked API key");
    if (!API_KEY_PERMISSIONS.includes(permission)) {
      throw new AppError("FORBIDDEN", "This API key cannot perform this action");
    }
    return { tenantId: apiKey.tenantId, actor: { type: "api_key", apiKeyId: apiKey.id } };
  }

  const user = await requirePermission(permission);
  return { tenantId: user.tenantId, actor: { type: "user", userId: user.id } };
}
