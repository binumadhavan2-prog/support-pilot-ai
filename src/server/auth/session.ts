import "server-only";
import { headers } from "next/headers";
import { forbidden, redirect } from "next/navigation";
import { cache } from "react";
import { AppError } from "@/lib/errors";
import { getAuth } from "./auth";
import { can, isRole, type Permission, type Role } from "./permissions";

/** The narrow user shape the rest of the app sees. Never pass raw session objects to the client. */
export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** Confirmed through the emailed link. Shown in Settings; not required to sign in. */
  emailVerified: boolean;
  /** Every tenant-owned query must filter by this. */
  tenantId: string;
}

/**
 * Data Access Layer entry point. Reads and validates the session cookie against the database on
 * every request (deduped within one render by React `cache`). Not cached across requests, so a
 * role change or ban takes effect immediately.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  // Read the request first: under Cache Components prerendering stops here, so the build never
  // initializes auth (which needs runtime secrets).
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session || session.user.banned) return null;
  const { id, name, email, role, tenantId, emailVerified } = session.user;
  // A role outside our RBAC model (e.g. edited directly in the DB) is treated as signed out.
  if (!isRole(role) || !tenantId) return null;
  return { id, name, email, role, tenantId, emailVerified: Boolean(emailVerified) };
});

// --- For API route handlers and server actions: throw typed errors. ---

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new AppError("UNAUTHENTICATED", "Authentication required");
  return user;
}

export async function requirePermission(permission: Permission): Promise<CurrentUser> {
  const user = await requireUser();
  if (!can(user.role, permission)) {
    throw new AppError("FORBIDDEN", "You do not have permission to perform this action");
  }
  return user;
}

// --- For pages and layouts: redirect or render the 403 page. Call inside a <Suspense> boundary. ---

export async function requirePageUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requirePagePermission(permission: Permission): Promise<CurrentUser> {
  const user = await requirePageUser();
  if (!can(user.role, permission)) forbidden();
  return user;
}
