import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { tenants, user } from "@/db/schema";
import type { AnyDatabase } from "@/db/types";
import { AppError } from "@/lib/errors";

export const tenantSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "Use 2-63 lower-case letters, digits or hyphens");

/** Returns the tenant with `slug`, creating it if needed. Idempotent; used by scripts and seeds. */
export async function ensureTenant(db: AnyDatabase, input: { slug: string; name: string }) {
  const slug = tenantSlugSchema.parse(input.slug);
  const [created] = await db
    .insert(tenants)
    .values({ slug, name: input.name })
    .onConflictDoNothing({ target: tenants.slug })
    .returning();
  if (created) return created;
  const [existing] = await db.select().from(tenants).where(eq(tenants.slug, slug));
  return existing;
}

export async function listTenantUsers(db: AnyDatabase, tenantId: string) {
  return db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      banned: user.banned,
      createdAt: user.createdAt,
    })
    .from(user)
    .where(eq(user.tenantId, tenantId))
    .orderBy(asc(user.createdAt));
}

/**
 * Throws NOT_FOUND unless `userId` belongs to `tenantId`. Run before any admin operation on
 * another user. The error is the same whether the user is missing or in another tenant, so it
 * does not reveal which ids exist elsewhere.
 */
export async function assertUserInTenant(db: AnyDatabase, tenantId: string, userId: string) {
  const [row] = await db
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.id, userId), eq(user.tenantId, tenantId)));
  if (!row) throw new AppError("NOT_FOUND", "User not found");
}
