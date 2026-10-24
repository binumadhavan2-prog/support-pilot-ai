import { existsSync, mkdirSync } from "node:fs";
import { request, type APIRequestContext, type FullConfig } from "@playwright/test";

/** Demo accounts from `npm run db:seed:demo`; they share DEMO_USER_PASSWORD. */
export const ROLES = ["admin", "agent", "viewer"] as const;
export type E2ERole = (typeof ROLES)[number];
export const emailFor = (role: E2ERole) => `${role}@demo.supportpilot.test`;
export const authFile = (role: E2ERole) => `tests/e2e/.auth/${role}.json`;

/**
 * Makes sure each demo role has a saved, signed-in session. Saved sessions are reused while they
 * are valid: the app allows only 5 sign-ins per minute in production, and signing in three roles
 * on every run would trip it.
 */
export default async function globalSetup(config: FullConfig) {
  const password = process.env.DEMO_USER_PASSWORD;
  if (!password) {
    throw new Error("DEMO_USER_PASSWORD is not set (see .env.local and npm run db:seed:demo)");
  }
  const baseURL = config.projects[0].use.baseURL!;
  mkdirSync("tests/e2e/.auth", { recursive: true });

  for (const role of ROLES) {
    if (existsSync(authFile(role)) && (await sessionIsValid(baseURL, role))) continue;
    const ctx = await request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
    await signIn(ctx, role, password);
    await ctx.storageState({ path: authFile(role) });
    await ctx.dispose();
  }
}

async function sessionIsValid(baseURL: string, role: E2ERole) {
  const ctx = await request.newContext({ baseURL, storageState: authFile(role) });
  try {
    const res = await ctx.get("/api/auth/get-session");
    const body = res.ok() ? await res.json().catch(() => null) : null;
    return body?.user?.email === emailFor(role);
  } finally {
    await ctx.dispose();
  }
}

async function signIn(ctx: APIRequestContext, role: E2ERole, password: string) {
  for (let attempt = 1; ; attempt++) {
    const res = await ctx.post("/api/auth/sign-in/email", {
      data: { email: emailFor(role), password },
    });
    if (res.ok()) return;
    if (res.status() === 429 && attempt === 1) {
      console.log(`sign-in rate limited for ${role}; waiting 61 s`);
      await new Promise((resolve) => setTimeout(resolve, 61_000));
      continue;
    }
    throw new Error(`Sign-in for ${role} failed: ${res.status()}`);
  }
}
