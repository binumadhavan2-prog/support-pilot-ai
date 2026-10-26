import { lt, sql } from "drizzle-orm";
import { rateLimits } from "@/db/schema";
import type { AnyDatabase } from "@/db/types";
import { AppError } from "@/lib/errors";

/** Requests per minute for one API key or user. Writes are scarcer than reads. */
export const API_RATE_LIMITS = { read: 300, write: 60 } as const;
export const RATE_WINDOW_SECONDS = 60;

/**
 * Counts one request against `key` in the current fixed window and throws RATE_LIMITED (429,
 * with Retry-After) once `limit` is exceeded. The increment is a single atomic upsert, so
 * concurrent requests can't both slip under the limit.
 */
export async function consumeRateLimit(
  db: AnyDatabase,
  key: string,
  limit: number,
  { windowSeconds = RATE_WINDOW_SECONDS, now = new Date() } = {},
) {
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.key, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning({ count: rateLimits.count });

  // Prune finished windows now and then, so the table stays small without a separate job.
  if (Math.random() < 0.01) {
    await db
      .delete(rateLimits)
      .where(lt(rateLimits.windowStart, new Date(now.getTime() - 3_600_000)));
  }

  const resetAt = windowStart.getTime() + windowMs;
  if (row.count > limit) {
    throw new AppError("RATE_LIMITED", "Too many requests. Slow down and retry later.", {
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now.getTime()) / 1000)),
    });
  }
  return { remaining: limit - row.count, resetAt: new Date(resetAt) };
}

/**
 * Better Auth's rate-limit storage on the same Postgres counters, so sign-in limits hold across
 * restarts and instances (its default is per-process memory). Keys are prefixed so they can't
 * collide with API keys' counters.
 */
export function authRateLimitStorage(db: AnyDatabase) {
  return {
    async consume(key: string, rule: { window: number; max: number }) {
      try {
        await consumeRateLimit(db, `auth:${key}`, rule.max, { windowSeconds: rule.window });
        return { allowed: true, retryAfter: null };
      } catch (error) {
        if (error instanceof AppError && error.code === "RATE_LIMITED") {
          return { allowed: false, retryAfter: error.retryAfterSeconds ?? rule.window };
        }
        throw error;
      }
    },
  };
}
