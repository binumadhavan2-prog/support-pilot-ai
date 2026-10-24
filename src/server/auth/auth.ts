import "server-only";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements } from "better-auth/plugins/admin/access";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { getEnv } from "@/env";

import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./constants";

/*
 * Better Auth's admin plugin guards its own user-management endpoints (create user, set role,
 * ban). Only `admin` gets those statements; agents and viewers get none. Application permissions
 * (tickets, drafts, ...) live in ./permissions.ts.
 */
const ac = createAccessControl(defaultStatements);
const authRoles = {
  admin: ac.newRole(adminAc.statements),
  agent: ac.newRole({ user: [], session: [] }),
  viewer: ac.newRole({ user: [], session: [] }),
};

interface CreateAuthOptions {
  // Any Drizzle Postgres database (postgres-js in the app, PGlite in tests).
  db: Parameters<typeof drizzleAdapter>[0];
  secret: string;
  baseURL: string;
  production: boolean;
  /** Next.js cookie bridge for server actions. Off for scripts and tests that run outside Next. */
  withNextCookies?: boolean;
}

/** Factory so integration tests can build an instance on an in-memory database. */
export function createAuth({
  db,
  secret,
  baseURL,
  production,
  withNextCookies = true,
}: CreateAuthOptions) {
  return betterAuth({
    appName: "Support Pilot AI",
    secret,
    baseURL,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: {
      enabled: true,
      // Internal tool: accounts are created by admins (or the seed script), never self-service.
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
    },
    user: {
      additionalFields: {
        // Set by server code only (input: false), so no client request can choose or change it.
        tenantId: { type: "string", required: true, input: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // refresh expiry at most once a day
    },
    rateLimit: {
      // In-memory limiter: fine for one instance, see README "Known limitations".
      enabled: production,
      window: 60,
      max: 100,
      customRules: { "/sign-in/email": { window: 60, max: 5 } },
    },
    advanced: {
      useSecureCookies: production,
      // Auth tables use text ids; random UUIDs keep them unguessable and consistent with our tables.
      database: { generateId: () => crypto.randomUUID() },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!ctx.path.startsWith("/admin/")) return;
        // The admin plugin is tenant-unaware: over HTTP, an admin of one tenant could list or
        // modify users of another. So its endpoints are server-only. Server actions call them via
        // `auth.api.*` (no `ctx.request`) after checking that the target is in the actor's tenant.
        if (ctx.request) {
          throw new APIError("FORBIDDEN", {
            message: "Admin endpoints are not available over HTTP",
          });
        }
        if (ctx.path !== "/admin/create-user") return;
        // Better Auth's admin create-user skips the minPasswordLength check that sign-up and
        // set-user-password apply (verified in tests/auth/auth.test.ts), so enforce it here.
        const password: unknown = ctx.body?.password;
        if (
          typeof password !== "string" ||
          password.length < MIN_PASSWORD_LENGTH ||
          password.length > MAX_PASSWORD_LENGTH
        ) {
          throw new APIError("BAD_REQUEST", {
            message: `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`,
          });
        }
      }),
    },
    plugins: [
      admin({ ac, roles: authRoles, defaultRole: "viewer", adminRoles: ["admin"] }),
      // Lets server actions set auth cookies. Must stay the last plugin.
      ...(withNextCookies ? [nextCookies()] : []),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const globalForAuth = globalThis as unknown as { __auth?: Auth };

export function getAuth(): Auth {
  if (!globalForAuth.__auth) {
    const env = getEnv();
    globalForAuth.__auth = createAuth({
      db: getDb(),
      secret: env.BETTER_AUTH_SECRET,
      baseURL: env.BETTER_AUTH_URL,
      production: env.NODE_ENV === "production",
    });
  }
  return globalForAuth.__auth;
}
