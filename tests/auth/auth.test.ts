import { isAPIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, tenants, user } from "@/db/schema";
import { createAuth, type Auth } from "@/server/auth/auth";
import { createTestDb, type TestDb } from "../db/test-db";

/*
 * Integration tests: the real Better Auth configuration running against migrated Postgres
 * (PGlite). Verifies our auth policy, not Better Auth internals.
 */

let db: TestDb;
let close: () => Promise<void>;
let auth: Auth;
let tenantId: string;

const PASSWORD = "correct-horse-battery";

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  auth = createAuth({
    db,
    secret: "test-secret-that-is-at-least-32-characters-long",
    baseURL: "http://localhost:3000",
    production: false,
    withNextCookies: false,
  });
  const [tenant] = await db.insert(tenants).values({ slug: "acme", name: "Acme" }).returning();
  tenantId = tenant.id;
});

afterAll(async () => {
  await close?.();
});

async function createUserWithRole(email: string, role: "admin" | "agent" | "viewer") {
  const { user: created } = await auth.api.createUser({
    body: { email, name: email.split("@")[0], password: PASSWORD, role, data: { tenantId } },
  });
  return created;
}

/** Signs in and returns request headers carrying the session cookie, like a browser would. */
async function signIn(email: string, password = PASSWORD): Promise<Headers> {
  const { headers } = await auth.api.signInEmail({
    body: { email, password },
    returnHeaders: true,
  });
  const cookie = headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return new Headers({ cookie });
}

async function expectApiError(promise: Promise<unknown>, status: number) {
  try {
    await promise;
    expect.unreachable("expected the call to fail");
  } catch (error) {
    expect(isAPIError(error)).toBe(true);
    if (isAPIError(error)) expect(error.statusCode).toBe(status);
  }
}

describe("account creation", () => {
  it("stores the requested role and hashes the password", async () => {
    const created = await createUserWithRole("agent1@example.test", "agent");
    const [row] = await db.select().from(user).where(eq(user.id, created.id));
    expect(row.role).toBe("agent");

    const [credential] = await db.select().from(account).where(eq(account.userId, created.id));
    expect(credential.password).toBeTruthy();
    expect(credential.password).not.toContain(PASSWORD);
  });

  it("defaults to the viewer role when none is given", async () => {
    const { user: created } = await auth.api.createUser({
      body: {
        email: "norole@example.test",
        name: "No Role",
        password: PASSWORD,
        data: { tenantId },
      },
    });
    const [row] = await db.select().from(user).where(eq(user.id, created.id));
    expect(row.role).toBe("viewer");
  });

  it("rejects public self sign-up", async () => {
    await expectApiError(
      auth.api.signUpEmail({
        body: { email: "selfserve@example.test", name: "Self", password: PASSWORD },
      }),
      400,
    );
    expect(await db.select().from(user).where(eq(user.email, "selfserve@example.test"))).toEqual(
      [],
    );
  });

  it("rejects passwords shorter than the minimum", async () => {
    await expectApiError(
      auth.api.createUser({
        body: { email: "short@example.test", name: "S", password: "short", data: { tenantId } },
      }),
      400,
    );
  });

  it("rejects roles outside the RBAC model", async () => {
    await expectApiError(
      auth.api.createUser({
        body: {
          email: "owner@example.test",
          name: "O",
          password: PASSWORD,
          role: "owner" as "admin",
          data: { tenantId },
        },
      }),
      400,
    );
  });
});

describe("tenancy", () => {
  it("stores the tenant on the user and exposes it on the session", async () => {
    await createUserWithRole("tenant-user@example.test", "agent");
    const session = await auth.api.getSession({
      headers: await signIn("tenant-user@example.test"),
    });
    expect(session?.user.tenantId).toBe(tenantId);
  });

  it("refuses to create a user without a tenant", async () => {
    await expect(
      auth.api.createUser({
        body: { email: "no-tenant@example.test", name: "N", password: PASSWORD },
      }),
    ).rejects.toThrow();
  });

  it("ignores a tenantId sent by the user in update-user", async () => {
    const [other] = await db.insert(tenants).values({ slug: "other", name: "Other" }).returning();
    await createUserWithRole("mover@example.test", "agent");
    const cookies = await signIn("mover@example.test");
    const updateUser = (body: object) =>
      auth.handler(
        new Request("http://localhost:3000/api/auth/update-user", {
          method: "POST",
          headers: {
            cookie: cookies.get("cookie")!,
            "content-type": "application/json",
            origin: "http://localhost:3000",
          },
          body: JSON.stringify(body),
        }),
      );

    // Control: the same request without tenantId succeeds, so a failure below is about tenantId.
    expect((await updateUser({ name: "Renamed" })).status).toBe(200);
    expect((await updateUser({ name: "Moved", tenantId: other.id })).status).toBe(400);

    const [row] = await db.select().from(user).where(eq(user.email, "mover@example.test"));
    expect(row.tenantId).toBe(tenantId);
  });
});

describe("sign-in and sessions", () => {
  beforeAll(async () => {
    await createUserWithRole("signin@example.test", "agent");
  });

  it("issues a session cookie that resolves to the user and role", async () => {
    const headers = await signIn("signin@example.test");
    const session = await auth.api.getSession({ headers });
    expect(session?.user.email).toBe("signin@example.test");
    expect(session?.user.role).toBe("agent");
  });

  it("rejects a wrong password", async () => {
    await expectApiError(signIn("signin@example.test", "wrong-password-123"), 401);
  });

  it("rejects an unknown email with the same status as a wrong password", async () => {
    await expectApiError(signIn("nobody@example.test"), 401);
  });

  it("returns no session after sign-out", async () => {
    const headers = await signIn("signin@example.test");
    await auth.api.signOut({ headers });
    expect(await auth.api.getSession({ headers })).toBeNull();
  });

  it("returns no session for a forged cookie", async () => {
    const headers = new Headers({ cookie: "better-auth.session_token=forged.value" });
    expect(await auth.api.getSession({ headers })).toBeNull();
  });
});

describe("admin endpoints", () => {
  let adminHeaders: Headers;
  let viewerHeaders: Headers;
  let agentHeaders: Headers;
  let targetId: string;

  beforeAll(async () => {
    await createUserWithRole("admin@example.test", "admin");
    await createUserWithRole("viewer@example.test", "viewer");
    await createUserWithRole("agent2@example.test", "agent");
    targetId = (await createUserWithRole("target@example.test", "viewer")).id;
    adminHeaders = await signIn("admin@example.test");
    viewerHeaders = await signIn("viewer@example.test");
    agentHeaders = await signIn("agent2@example.test");
  });

  it("let admins list users and change roles", async () => {
    const { users } = await auth.api.listUsers({ query: {}, headers: adminHeaders });
    expect(users.length).toBeGreaterThan(0);

    await auth.api.setRole({ body: { userId: targetId, role: "agent" }, headers: adminHeaders });
    const [row] = await db.select().from(user).where(eq(user.id, targetId));
    expect(row.role).toBe("agent");
  });

  it.each([
    ["viewer", () => viewerHeaders],
    ["agent", () => agentHeaders],
  ])("deny %s access to user management", async (_role, getHeaders) => {
    await expectApiError(auth.api.listUsers({ query: {}, headers: getHeaders() }), 403);
    await expectApiError(
      auth.api.setRole({ body: { userId: targetId, role: "admin" }, headers: getHeaders() }),
      403,
    );
    await expectApiError(
      auth.api.createUser({
        body: {
          email: "escalate@example.test",
          name: "E",
          password: PASSWORD,
          role: "admin",
          data: { tenantId },
        },
        headers: getHeaders(),
      }),
      403,
    );
  });

  it("are not reachable over HTTP, even for admins (they are tenant-unaware)", async () => {
    for (const path of ["list-users", "set-role", "create-user", "ban-user"]) {
      const response = await auth.handler(
        new Request(`http://localhost:3000/api/auth/admin/${path}`, {
          method: path === "list-users" ? "GET" : "POST",
          headers: {
            cookie: adminHeaders.get("cookie")!,
            "content-type": "application/json",
            origin: "http://localhost:3000",
          },
          body:
            path === "list-users" ? undefined : JSON.stringify({ userId: targetId, role: "admin" }),
        }),
      );
      expect(response.status, path).toBe(403);
    }
  });

  it("reject unauthenticated callers that send request headers", async () => {
    await expectApiError(auth.api.listUsers({ query: {}, headers: new Headers() }), 401);
  });

  it("ban revokes existing sessions and blocks new sign-ins; unban restores access", async () => {
    const bannedId = (await createUserWithRole("banned@example.test", "agent")).id;
    const bannedHeaders = await signIn("banned@example.test");
    expect(await auth.api.getSession({ headers: bannedHeaders })).not.toBeNull();

    await auth.api.banUser({ body: { userId: bannedId }, headers: adminHeaders });

    expect(await auth.api.getSession({ headers: bannedHeaders })).toBeNull();
    await expectApiError(signIn("banned@example.test"), 403);

    await auth.api.unbanUser({ body: { userId: bannedId }, headers: adminHeaders });
    const restored = await signIn("banned@example.test");
    expect(await auth.api.getSession({ headers: restored })).not.toBeNull();
  });
});
