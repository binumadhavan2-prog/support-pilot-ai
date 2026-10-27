import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLogs, session, tenants, user } from "@/db/schema";
import {
  RESET_REQUESTED_MESSAGE,
  requestPasswordReset,
  resetPassword,
  sendEmailVerification,
} from "@/server/auth/account-email";
import { createAuth, type Auth } from "@/server/auth/auth";
import { createTestDb, type TestDb } from "../db/test-db";
import { mockMailer } from "../email/mock-mailer";

/* Password reset and email verification with the real Better Auth config on PGlite and a MOCK
 * mailer (nothing is sent). */

let db: TestDb;
let close: () => Promise<void>;
let auth: Auth;
let tenantId: string;
const mailer = mockMailer();
const BASE = "http://localhost:3000";
const PASSWORD = "correct-horse-battery";
const NEW_PASSWORD = "a-brand-new-password";

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  auth = createAuth({
    db,
    secret: "test-secret-that-is-at-least-32-characters-long",
    baseURL: BASE,
    production: false,
    withNextCookies: false,
    mailer,
  });
  const [tenant] = await db.insert(tenants).values({ slug: "acme", name: "Acme" }).returning();
  tenantId = tenant.id;
});

afterAll(async () => {
  await close?.();
});

/** Not a reserved domain, so the (mock) mailer is asked to send. */
async function createUser(email: string) {
  const { user: created } = await auth.api.createUser({
    body: { email, name: "Dana Lee", password: PASSWORD, role: "agent", data: { tenantId } },
  });
  return created;
}

/** Auth emails are sent without awaiting (timing safety), so wait for them to arrive. */
async function nextEmail(to: string, before: number) {
  for (let i = 0; i < 50; i++) {
    const found = mailer.sent.slice(before).find((e) => e.to === to);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no email to ${to}`);
}

const signIn = (email: string, password: string) =>
  auth.api.signInEmail({ body: { email, password } }).then(
    () => true,
    () => false,
  );

describe("password reset", () => {
  it("emails a link, sets the new password, signs out every session and audits it", async () => {
    const dana = await createUser("dana@customer-mail.net");
    await auth.api.signInEmail({ body: { email: dana.email, password: PASSWORD } });
    const before = mailer.sent.length;

    const result = await requestPasswordReset(auth, db, { email: dana.email, ip: "203.0.113.1" });
    expect(result.message).toBe(RESET_REQUESTED_MESSAGE);
    const email = await nextEmail(dana.email, before);
    expect(email.subject).toBe("Reset your Support Pilot AI password");
    const token = /\/reset-password\?token=([^\s]+)/.exec(email.text)?.[1];
    expect(email.text).toContain(`${BASE}/reset-password?token=`);
    expect(token).toBeTruthy();

    await resetPassword(auth, {
      token: decodeURIComponent(token!),
      password: NEW_PASSWORD,
    });
    expect(await signIn(dana.email, PASSWORD)).toBe(false);
    expect(await signIn(dana.email, NEW_PASSWORD)).toBe(true);

    // Sessions from before the reset are gone (only the one just created remains).
    const sessions = await db.select().from(session).where(eq(session.userId, dana.id));
    expect(sessions).toHaveLength(1);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, dana.id), eq(auditLogs.action, "auth.password_reset")));
    expect(audits).toHaveLength(1);

    // The link works once.
    await expect(
      resetPassword(auth, { token: decodeURIComponent(token!), password: "yet-another-password" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: /invalid or has expired/ });
  });

  it("answers the same for an unknown email and sends nothing", async () => {
    const before = mailer.sent.length;
    const result = await requestPasswordReset(auth, db, {
      email: "nobody@customer-mail.net",
      ip: "203.0.113.2",
    });
    expect(result.message).toBe(RESET_REQUESTED_MESSAGE);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mailer.sent.length).toBe(before);
  });

  it("rejects a made-up token", async () => {
    await expect(
      resetPassword(auth, { token: "not-a-real-token", password: NEW_PASSWORD }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("never emails reserved test addresses (demo accounts)", async () => {
    const demo = await createUser("viewer@demo.supportpilot.test");
    const before = mailer.sent.length;
    await requestPasswordReset(auth, db, { email: demo.email, ip: "203.0.113.3" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mailer.sent.length).toBe(before);
  });

  it("limits requests per email", async () => {
    const ctx = { email: "limited@customer-mail.net", ip: null };
    for (let i = 0; i < 3; i++)
      await requestPasswordReset(auth, db, { ...ctx, ip: `198.51.100.${i}` });
    await expect(
      requestPasswordReset(auth, db, { ...ctx, ip: "198.51.100.9" }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("email verification", () => {
  it("emails a link that marks the address verified and audits it", async () => {
    const sam = await createUser("sam@customer-mail.net");
    expect(sam.emailVerified).toBe(false);
    const before = mailer.sent.length;

    await sendEmailVerification(auth, db, { userId: sam.id, email: sam.email });
    const email = await nextEmail(sam.email, before);
    expect(email.subject).toBe("Confirm your email for Support Pilot AI");
    const url = /(http\S+verify-email\S+)/.exec(email.text)?.[1];
    expect(url).toBeTruthy();

    // Opening the link: Better Auth verifies and redirects to Settings.
    const response = await auth.handler(new Request(url!));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/settings?verified=1");
    const [row] = await db.select().from(user).where(eq(user.id, sam.id));
    expect(row.emailVerified).toBe(true);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, sam.id), eq(auditLogs.action, "auth.email_verified")));
    expect(audits).toHaveLength(1);
  });

  it("limits resends to 3 an hour per user", async () => {
    const kim = await createUser("kim@customer-mail.net");
    for (let i = 0; i < 3; i++) {
      await sendEmailVerification(auth, db, { userId: kim.id, email: kim.email });
    }
    await expect(
      sendEmailVerification(auth, db, { userId: kim.id, email: kim.email }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});
