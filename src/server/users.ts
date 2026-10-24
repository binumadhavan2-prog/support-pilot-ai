import { z } from "zod";
import { AppError } from "@/lib/errors";
import { MIN_PASSWORD_LENGTH } from "./auth/constants";
import { ROLES, type Role } from "./auth/permissions";

export const createUserSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  email: z
    .email("Enter a valid email")
    .max(254)
    .transform((v) => v.toLowerCase()),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    .max(128),
  role: z.enum(ROLES),
});

export const setRoleSchema = z.object({ userId: z.string().min(1), role: z.enum(ROLES) });
export const userIdSchema = z.object({ userId: z.string().min(1) });

/**
 * Guards admins against locking themselves (and possibly everyone) out: they cannot demote or
 * ban their own account. Another admin has to do it.
 */
export function assertNotSelfLockout(
  actor: { id: string },
  targetUserId: string,
  change: { kind: "set-role"; role: Role } | { kind: "ban" },
) {
  if (actor.id !== targetUserId) return;
  if (change.kind === "ban") {
    throw new AppError("CONFLICT", "You cannot ban your own account.");
  }
  if (change.role !== "admin") {
    throw new AppError("CONFLICT", "You cannot remove your own admin role.");
  }
}
