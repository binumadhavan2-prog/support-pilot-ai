import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tenants } from "@/db/schema";
import { createAuth, type Auth } from "@/server/auth/auth";
import { createApiKey, verifyApiKey } from "@/server/api-keys";
import { createTestDb, type TestDb } from "../db/test-db";

/*
 * Endpoint tests: the real route handlers, Better Auth sessions and services, on a migrated
 * in-memory Postgres. Only the Next.js request plumbing is replaced: `getDb`/`getAuth` return
 * the test instances and `headers()` returns the simulated browser's cookies.
 */
const ctx = vi.hoisted(() => {
  // Route handlers read the validated environment (e.g. RUN_JOBS_INLINE), as in a real deployment,
  // where the server refuses to start without these. getDb/getAuth are swapped below, so the
  // placeholders are never used to connect.
  process.env.DATABASE_URL ??= "postgres://placeholder@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "test-secret-that-is-at-least-32-characters-long";
  return {
    db: undefined as unknown as TestDb,
    auth: undefined as unknown as Auth,
    cookies: new Headers(),
  };
});

vi.mock("@/db/client", () => ({ getDb: () => ctx.db }));
vi.mock("@/server/auth/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/auth")>()),
  getAuth: () => ctx.auth,
}));
vi.mock("next/headers", () => ({ headers: async () => ctx.cookies }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  // Outside a Next.js request there is nothing to defer; prerendering does not apply here.
  connection: async () => {},
}));

const ticketsRoute = await import("@/app/api/tickets/route");
const ticketRoute = await import("@/app/api/tickets/[id]/route");
const emailRoute = await import("@/app/api/tickets/email/route");

const PASSWORD = "correct-horse-battery";
let close: () => Promise<void>;
let keyA: string;
let keyB: string;
let viewerA: Headers;
let agentA: Headers;
let agentB: Headers;

beforeAll(async () => {
  let db: TestDb;
  ({ db, close } = await createTestDb());
  ctx.db = db;
  ctx.auth = createAuth({
    db,
    secret: "test-secret-that-is-at-least-32-characters-long",
    baseURL: "http://localhost:3000",
    production: false,
    withNextCookies: false,
  });
  const [a, b] = await db
    .insert(tenants)
    .values([
      { slug: "tenant-a", name: "Tenant A" },
      { slug: "tenant-b", name: "Tenant B" },
    ])
    .returning();
  keyA = (await createApiKey(db, { tenantId: a.id, name: "A webhook" })).key;
  keyB = (await createApiKey(db, { tenantId: b.id, name: "B webhook" })).key;
  viewerA = await signedIn("viewer@a.test", "viewer", a.id);
  agentA = await signedIn("agent@a.test", "agent", a.id);
  agentB = await signedIn("agent@b.test", "agent", b.id);
});

afterAll(async () => {
  await close?.();
});

beforeEach(() => {
  ctx.cookies = new Headers();
});

/** Creates a user and returns the cookie header a browser would send after signing in. */
async function signedIn(email: string, role: "agent" | "viewer", tenantId: string) {
  await ctx.auth.api.createUser({
    body: { email, name: email, password: PASSWORD, role, data: { tenantId } },
  });
  const { headers } = await ctx.auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  });
  const cookie = headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return new Headers({ cookie });
}

type As = { key?: string; session?: Headers };

function request(path: string, as: As, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (as.key) headers.set("authorization", `Bearer ${as.key}`);
  if (as.session) {
    ctx.cookies = as.session;
    headers.set("cookie", as.session.get("cookie")!);
  }
  return new Request(`http://localhost:3000${path}`, { ...init, headers });
}

const ticketJson = (subject: string) =>
  JSON.stringify({
    subject,
    body: "The export button does nothing.",
    customer: { name: "Dana Lee", email: "Dana@Example.test" },
  });

async function postTicket(as: As, subject = "Export is broken") {
  return ticketsRoute.POST(
    request("/api/tickets", as, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: ticketJson(subject),
    }),
  );
}

async function listAs(as: As, qs = "") {
  return ticketsRoute.GET(request(`/api/tickets${qs}`, as));
}

async function getAs(as: As, id: string) {
  return ticketRoute.GET(request(`/api/tickets/${id}`, as), { params: Promise.resolve({ id }) });
}

describe("POST /api/tickets", () => {
  it("creates a ticket with an API key, and it appears in the tenant's inbox", async () => {
    const res = await postTicket({ key: keyA }, "Created over the webhook");
    expect(res.status).toBe(201);
    const { ticket } = await res.json();
    expect(ticket).toMatchObject({ status: "open", number: expect.any(Number) });
    expect(res.headers.get("location")).toBe(`/api/tickets/${ticket.id}`);

    const list = await (await listAs({ session: viewerA })).json();
    expect(list.items.map((t: { id: string }) => t.id)).toContain(ticket.id);
    const created = list.items.find((t: { id: string }) => t.id === ticket.id);
    expect(created).toMatchObject({
      subject: "Created over the webhook",
      customerEmail: "dana@example.test",
      isDemo: false,
    });
  });

  it("lets an agent create a ticket with their session", async () => {
    expect((await postTicket({ session: agentA })).status).toBe(201);
  });

  it("rejects missing, malformed and unknown credentials with 401", async () => {
    for (const as of [{}, { key: "nope" }, { key: `sp_${"x".repeat(43)}` }]) {
      const res = await postTicket(as);
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("does not fall back to the session when a bad API key is sent", async () => {
    expect((await postTicket({ key: "bad", session: agentA })).status).toBe(401);
  });

  it("forbids viewers from creating tickets", async () => {
    const res = await postTicket({ session: viewerA });
    expect(res.status).toBe(403);
  });

  it("returns 400 with field errors for an invalid body, and for malformed JSON", async () => {
    const invalid = await ticketsRoute.POST(
      request("/api/tickets", { key: keyA }, { method: "POST", body: '{"subject":""}' }),
    );
    expect(invalid.status).toBe(400);
    const body = await invalid.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details.fieldErrors).toHaveProperty("subject");

    const malformed = await ticketsRoute.POST(
      request("/api/tickets", { key: keyA }, { method: "POST", body: "{not json" }),
    );
    expect(malformed.status).toBe(400);
  });

  it("ignores a tenant id in the body", async () => {
    const res = await ticketsRoute.POST(
      request(
        "/api/tickets",
        { key: keyB },
        {
          method: "POST",
          body: JSON.stringify({ ...JSON.parse(ticketJson("Sneaky")), tenantId: "tenant-a" }),
        },
      ),
    );
    const { ticket } = await res.json();
    expect((await getAs({ key: keyA }, ticket.id)).status).toBe(404);
    expect((await getAs({ key: keyB }, ticket.id)).status).toBe(200);
  });
});

describe("POST /api/tickets/email", () => {
  const rawEmail = [
    'From: "Omar Haddad" <omar@example.test>',
    "To: support@acme.test",
    "Subject: Cannot download invoice",
    "Message-ID: <abc123@example.test>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hi team,",
    "The invoice PDF link returns an error.",
  ].join("\r\n");

  const postEmail = (as: As, body: string) =>
    emailRoute.POST(
      request("/api/tickets/email", as, {
        method: "POST",
        headers: { "content-type": "message/rfc822" },
        body,
      }),
    );

  it("parses the sender, subject and body into a ticket", async () => {
    const res = await postEmail({ key: keyA }, rawEmail);
    expect(res.status).toBe(201);
    const { ticket } = await res.json();

    const detail = await (await getAs({ key: keyA }, ticket.id)).json();
    expect(detail.ticket).toMatchObject({
      subject: "Cannot download invoice",
      customerName: "Omar Haddad",
      customerEmail: "omar@example.test",
    });
    expect(detail.ticket.messages[0].body).toBe("Hi team,\nThe invoice PDF link returns an error.");
  });

  it("rejects an empty body, a message without a sender, and oversized input", async () => {
    expect((await postEmail({ key: keyA }, "")).status).toBe(400);
    expect((await postEmail({ key: keyA }, "Subject: hi\r\n\r\nno sender")).status).toBe(400);
    const huge = `${rawEmail}\r\n${"x".repeat(2 * 1024 * 1024)}`;
    expect((await postEmail({ key: keyA }, huge)).status).toBe(413);
  });

  it("requires authentication", async () => {
    expect((await postEmail({}, rawEmail)).status).toBe(401);
  });
});

describe("GET /api/tickets", () => {
  it("filters, searches and paginates", async () => {
    await postTicket({ key: keyA }, "Unique zebra subject");
    const found = await (await listAs({ key: keyA }, "?search=zebra&status=open")).json();
    expect(found.items.map((t: { subject: string }) => t.subject)).toEqual([
      "Unique zebra subject",
    ]);
    const page = await (await listAs({ key: keyA }, "?pageSize=1&page=2")).json();
    expect(page).toMatchObject({ page: 2, pageSize: 1 });
    expect(page.items).toHaveLength(1);
  });

  it("rejects invalid filter values", async () => {
    const res = await listAs({ key: keyA }, "?status=everything");
    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    expect((await listAs({})).status).toBe(401);
  });
});

describe("tenant isolation", () => {
  it("user and key in tenant B cannot see tenant A's tickets", async () => {
    const { ticket } = await (await postTicket({ key: keyA }, "Tenant A only")).json();

    for (const as of [{ key: keyB }, { session: agentB }]) {
      const list = await (await listAs(as)).json();
      expect(list.items.map((t: { id: string }) => t.id)).not.toContain(ticket.id);
      expect(list.items.map((t: { subject: string }) => t.subject)).not.toContain("Tenant A only");

      const res = await getAs(as, ticket.id);
      expect(res.status).toBe(404);
      expect((await res.json()).error.message).toBe("Ticket not found");
    }

    expect((await getAs({ session: viewerA }, ticket.id)).status).toBe(200);
  });
});

describe("PATCH /api/tickets/{id}", () => {
  const patch = (as: As, id: string, body: unknown) =>
    ticketRoute.PATCH(
      request(`/api/tickets/${id}`, as, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );

  it("lets an API key or an agent change status, but not a viewer", async () => {
    const { ticket } = await (await postTicket({ key: keyA }, "To resolve")).json();

    const byKey = await patch({ key: keyA }, ticket.id, { status: "resolved" });
    expect(byKey.status).toBe(200);
    expect(await byKey.json()).toMatchObject({ changed: true, ticket: { status: "resolved" } });

    expect((await patch({ session: agentA }, ticket.id, { status: "open" })).status).toBe(200);
    expect((await patch({ session: viewerA }, ticket.id, { status: "closed" })).status).toBe(403);
  });

  it("validates the body and hides other tenants' tickets", async () => {
    const { ticket } = await (await postTicket({ key: keyA }, "Validation")).json();
    expect((await patch({ key: keyA }, ticket.id, {})).status).toBe(400);
    expect((await patch({ key: keyA }, ticket.id, { status: "done" })).status).toBe(400);
    expect((await patch({ key: keyA }, ticket.id, { assigneeId: "nobody" })).status).toBe(400);
    expect((await patch({ key: keyB }, ticket.id, { status: "closed" })).status).toBe(404);
  });
});

describe("API hardening", () => {
  it("replays a ticket for a repeated Idempotency-Key and rejects a malformed key", async () => {
    const post = (key: string) =>
      ticketsRoute.POST(
        request(
          "/api/tickets",
          { key: keyA },
          {
            method: "POST",
            headers: { "content-type": "application/json", "idempotency-key": key },
            body: ticketJson("Idempotent"),
          },
        ),
      );
    const first = await post("order-42-delivery-1");
    const retry = await post("order-42-delivery-1");
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect((await retry.json()).ticket.id).toBe((await first.json()).ticket.id);
    expect((await post("has spaces in it")).status).toBe(400);
  });

  it("dedupes a retried email by its Message-ID", async () => {
    const raw = [
      "From: Lee <lee@example.test>",
      "Subject: Retry me",
      "Message-ID: <retry-1@mail.example>",
      "",
      "Body",
    ].join("\r\n");
    const send = () =>
      emailRoute.POST(request("/api/tickets/email", { key: keyA }, { method: "POST", body: raw }));
    const first = await send();
    const retry = await send();
    expect([first.status, retry.status]).toEqual([201, 200]);
    expect((await retry.json()).ticket.id).toBe((await first.json()).ticket.id);
  });

  it("rejects an oversized JSON body with 413", async () => {
    const res = await ticketsRoute.POST(
      request(
        "/api/tickets",
        { key: keyA },
        { method: "POST", body: JSON.stringify({ subject: "x".repeat(1024 * 1024 + 10) }) },
      ),
    );
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rate-limits writes per API key with 429 and Retry-After", async () => {
    const tenantA = (await verifyApiKey(ctx.db, keyA))!.tenantId;
    const { key } = await createApiKey(ctx.db, { tenantId: tenantA, name: "burst" });
    const { ticket } = await (await postTicket({ key: keyA }, "Rate limit target")).json();
    const patch = () =>
      ticketRoute.PATCH(
        request(
          `/api/tickets/${ticket.id}`,
          { key },
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "open" }),
          },
        ),
        { params: Promise.resolve({ id: ticket.id }) },
      );
    // Freeze the clock inside one rate-limit window, so a minute boundary can't reset the count.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T10:00:05Z"));
    const statuses: number[] = [];
    let limited: Response;
    try {
      for (let i = 0; i < 60; i++) statuses.push((await patch()).status);
      limited = await patch();
    } finally {
      vi.useRealTimers();
    }
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("55");
    // Another key is unaffected.
    expect((await listAs({ key: keyA })).status).toBe(200);
  });
});

describe("threaded email replies", () => {
  const send = (as: As, raw: string) =>
    emailRoute.POST(request("/api/tickets/email", as, { method: "POST", body: raw }));
  const email = (from: string, subject: string, messageId: string, body: string[]) =>
    [`From: ${from}`, `Subject: ${subject}`, `Message-ID: <${messageId}>`, "", ...body].join(
      "\r\n",
    );
  const resolve = (id: string) =>
    ticketRoute.PATCH(
      request(
        `/api/tickets/${id}`,
        { key: keyA },
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "resolved" }),
        },
      ),
      { params: Promise.resolve({ id }) },
    );

  async function newTicket(sender: string, tag: string) {
    const res = await send(
      { key: keyA },
      email(sender, `Export broken ${tag}`, `first-${tag}@mail.example`, ["The export fails."]),
    );
    return (await res.json()).ticket as { id: string; number: number };
  }

  it("adds the customer's reply to the ticket, without the quoted history, and reopens it", async () => {
    const ticket = await newTicket("Mia Fischer <mia@example.test>", "t1");
    expect((await resolve(ticket.id)).status).toBe(200);

    const res = await send(
      { key: keyA },
      email(
        "MIA@example.test",
        `Re: Export broken t1 [#${ticket.number}]`,
        "reply-t1@mail.example",
        [
          "Still failing for me, sorry.",
          "",
          "On Mon, 26 Oct 2026 at 10:00, Acme Support <help@acme.test> wrote:",
          "> We fixed the export.",
          "> --",
          `> Ticket #${ticket.number}`,
        ],
      ),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ threaded: true, ticket: { id: ticket.id, status: "open" } });

    const detail = await (await getAs({ key: keyA }, ticket.id)).json();
    expect(detail.ticket.status).toBe("open");
    expect(detail.ticket.resolvedAt).toBeNull();
    expect(detail.ticket.messages.map((m: { body: string }) => m.body)).toEqual([
      "The export fails.",
      "Still failing for me, sorry.",
    ]);
  });

  it("adds a retried delivery only once", async () => {
    const ticket = await newTicket("Noah <noah@example.test>", "t2");
    const reply = email("noah@example.test", `Re: [#${ticket.number}]`, "reply-t2@mail.example", [
      "One more detail.",
    ]);
    const first = await send({ key: keyA }, reply);
    const retry = await send({ key: keyA }, reply);
    expect([first.status, retry.status]).toEqual([201, 200]);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    const detail = await (await getAs({ key: keyA }, ticket.id)).json();
    expect(detail.ticket.messages).toHaveLength(2);
  });

  it("opens a new ticket when the sender isn't the ticket's customer", async () => {
    const ticket = await newTicket("Ava <ava@example.test>", "t3");
    const res = await send(
      { key: keyA },
      email("attacker@example.test", `Re: [#${ticket.number}]`, "spoof-t3@mail.example", [
        "Please change the account owner.",
      ]),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.threaded).toBeUndefined();
    expect(body.ticket.id).not.toBe(ticket.id);
    const original = await (await getAs({ key: keyA }, ticket.id)).json();
    expect(original.ticket.messages).toHaveLength(1);
  });

  it("never threads into another tenant's ticket", async () => {
    const ticket = await newTicket("Liam <liam@example.test>", "t4");
    // Same sender and number, but delivered with tenant B's key.
    const res = await send(
      { key: keyB },
      email("liam@example.test", `Re: [#${ticket.number}]`, "cross-t4@mail.example", ["Hello"]),
    );
    const body = await res.json();
    expect(body.threaded).toBeUndefined();
    const original = await (await getAs({ key: keyA }, ticket.id)).json();
    expect(original.ticket.messages).toHaveLength(1);
  });
});
