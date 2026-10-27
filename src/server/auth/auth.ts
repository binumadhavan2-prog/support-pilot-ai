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
import type { AnyDatabase } from "@/db/types";
import { getEnv } from "@/env";
import { recordAudit } from "../audit";
import { sendAuthEmail } from "../email/auth-emails";
import { getMailer, type Mailer } from "../email/mailer";
import { authRateLimitStorage } from "../rate-limit";

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
  db: AnyDatabase;
  secret: string;
  baseURL: string;
  production: boolean;
  /** Next.js cookie bridge for server actions. Off for scripts and tests that run outside Next. */
  withNextCookies?: boolean;
  /** Sends password-reset and verification emails; null when email is not configured. */
  mailer?: Mailer | null;
}

/** Link to the app's own reset page (the token is single-use and expires after an hour). */
export function passwordResetUrl(baseURL: string, token: string) {
  return `${baseURL}/reset-password?token=${encodeURIComponent(token)}`;
}

type AuthUser = { id: string; email: string; name: string; tenantId?: unknown };

/** Factory so integration tests can build an instance on an in-memory database. */
export function createAuth({
  db,
  secret,
  baseURL,
  production,
  withNextCookies = true,
  mailer = null,
}: CreateAuthOptions) {
  const audit = (user: AuthUser, action: string) =>
    typeof user.tenantId === "string"
      ? recordAudit(
          {
            tenantId: user.tenantId,
            actorId: user.id,
            action,
            entityType: "user",
            entityId: user.id,
          },
          db,
        )
      : Promise.resolve();

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
      // Not required to sign in: accounts are admin-created, and requiring it would lock out
      // existing and demo users. Verification is shown to admins instead.
      requireEmailVerification: false,
      resetPasswordTokenExpiresIn: 60 * 60,
      // A reset means the old password may be known to someone else: end every session.
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }) => {
        // Not awaited, so the response time doesn't reveal whether the account exists.
        void sendAuthEmail(mailer, "password_reset", user, passwordResetUrl(baseURL, token));
      },
      onPasswordReset: async ({ user }) => {
        await audit(user as AuthUser, "auth.password_reset");
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        void sendAuthEmail(mailer, "email_verification", user, url);
      },
      expiresIn: 60 * 60 * 24,
      autoSignInAfterVerification: false,
      afterEmailVerification: async (user) => {
        await audit(user as AuthUser, "auth.email_verified");
      },
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
      enabled: production,
      // Counted in Postgres (rate_limits), so limits survive restarts and hold across instances.
      customStorage: authRateLimitStorage(db),
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
      mailer: getMailer(),
    });
  }
  return globalForAuth.__auth;
}
