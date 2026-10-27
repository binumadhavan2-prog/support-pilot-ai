import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiDrafts, kbQueries, tenants, tickets, triageResults, user } from "@/db/schema";
import { getAnalytics, parseRange } from "@/server/analytics";
import { createTestDb, type TestDb } from "./test-db";

/* Analytics on PGlite with hand-placed timestamps, so every number is known in advance. */

let db: TestDb;
let close: () => Promise<void>;
let tenantA: string;
let tenantB: string;

// "Now" is fixed: 2026-10-20 12:00 UTC. The 7-day window starts 2026-10-14 00:00 UTC.
const NOW = new Date("2026-10-20T12:00:00Z");
const at = (iso: string) => new Date(iso);
const hours = (from: string, h: number) => new Date(at(from).getTime() + h * 3_600_000);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const [a, b] = await db
    .insert(tenants)
    .values([
      { slug: "tenant-a", name: "Tenant A" },
      { slug: "tenant-b", name: "Tenant B" },
    ])
    .returning();
  tenantA = a.id;
  tenantB = b.id;
  await db.insert(user).values([
    { id: "sam", tenantId: tenantA, name: "Sam", email: "sam@a.test", role: "agent" },
    { id: "ava", tenantId: tenantA, name: "Ava", email: "ava@a.test", role: "admin" },
  ]);

  const base = { customerName: "C", customerEmail: "c@x.test" };
  const rows = await db
    .insert(tickets)
    .values([
      // In the window: answered after 1h, resolved after 10h.
      {
        ...base,
        tenantId: tenantA,
        subject: "t1",
        status: "resolved",
        priority: "urgent",
        category: "billing",
        createdAt: at("2026-10-15T08:00:00Z"),
        firstResponseAt: hours("2026-10-15T08:00:00Z", 1),
        resolvedAt: hours("2026-10-15T08:00:00Z", 10),
      },
      // In the window: answered after 3h, still pending, assigned to Sam.
      {
        ...base,
        tenantId: tenantA,
        subject: "t2",
        status: "pending",
        priority: "high",
        category: "technical",
        assigneeId: "sam",
        createdAt: at("2026-10-15T09:00:00Z"),
        firstResponseAt: hours("2026-10-15T09:00:00Z", 3),
      },
      // In the window: open, unanswered, untriaged, assigned to Sam.
      {
        ...base,
        tenantId: tenantA,
        subject: "t3",
        status: "open",
        assigneeId: "sam",
        createdAt: at("2026-10-20T10:00:00Z"),
      },
      // Before the window, resolved inside it after 50h; open count excludes it.
      {
        ...base,
        tenantId: tenantA,
        subject: "t4",
        status: "closed",
        priority: "low",
        createdAt: at("2026-10-12T00:00:00Z"),
        firstResponseAt: hours("2026-10-12T00:00:00Z", 5),
        resolvedAt: hours("2026-10-12T00:00:00Z", 50),
      },
      // Before the window and still open, unassigned: backlog only.
      {
        ...base,
        tenantId: tenantA,
        subject: "t5",
        status: "open",
        createdAt: at("2026-10-01T00:00:00Z"),
      },
      // Another tenant: must never be counted.
      {
        ...base,
        tenantId: tenantB,
        subject: "b1",
        status: "open",
        priority: "urgent",
        createdAt: at("2026-10-16T00:00:00Z"),
      },
    ])
    .returning({ id: tickets.id, subject: tickets.subject });
  const id = (s: string) => rows.find((r) => r.subject === s)!.id;

  const draft = (
    status: "approved" | "edited" | "rejected" | "pending",
    grounded: boolean,
    tenantId = tenantA,
    ticketId = id("t1"),
  ) => ({
    tenantId,
    ticketId,
    body: "x",
    status,
    groundingStatus: grounded ? ("grounded" as const) : ("insufficient_evidence" as const),
    model: "m",
    inputTokens: 100,
    outputTokens: 10,
    createdAt: at("2026-10-16T00:00:00Z"),
  });
  await db.insert(aiDrafts).values([
    draft("approved", true),
    draft("approved", true),
    draft("edited", true),
    draft("rejected", false),
    draft("pending", true),
    { ...draft("approved", true), createdAt: at("2026-09-01T00:00:00Z") }, // outside the window
    draft("approved", true, tenantB, id("b1")),
  ]);

  const triage = {
    category: "billing" as const,
    priority: "high" as const,
    sentiment: "neutral" as const,
    language: "en",
    summary: "s",
    confidence: 0.9,
    model: "m",
    inputTokens: 1000,
    outputTokens: 50,
  };
  await db.insert(triageResults).values([
    {
      ...triage,
      tenantId: tenantA,
      ticketId: id("t1"),
      latencyMs: 2000,
      createdAt: at("2026-10-15T08:01:00Z"),
    },
    {
      ...triage,
      tenantId: tenantA,
      ticketId: id("t2"),
      latencyMs: 4000,
      isInjection: true,
      createdAt: at("2026-10-15T09:01:00Z"),
    },
    {
      ...triage,
      tenantId: tenantB,
      ticketId: id("b1"),
      latencyMs: 9000,
      isInjection: true,
      createdAt: at("2026-10-16T00:01:00Z"),
    },
  ]);
  await db.insert(kbQueries).values([
    {
      tenantId: tenantA,
      question: "q",
      answer: "a",
      groundingStatus: "grounded",
      model: "m",
      inputTokens: 500,
      outputTokens: 40,
      createdAt: at("2026-10-17T00:00:00Z"),
    },
    {
      tenantId: tenantA,
      question: "q",
      answer: "a",
      groundingStatus: "insufficient_evidence",
      model: "m",
      inputTokens: 500,
      outputTokens: 40,
      createdAt: at("2026-10-18T00:00:00Z"),
    },
  ]);
});

afterAll(async () => {
  await close?.();
});

describe("getAnalytics", () => {
  it("summarizes tickets in the window, with medians in hours", async () => {
    const a = await getAnalytics(db, tenantA, 7, NOW);
    expect(a.since.toISOString()).toBe("2026-10-14T00:00:00.000Z");
    expect(a.tickets).toEqual({
      created: 3,
      answered: 2,
      answeredWithinSla: 2, // t1 urgent at exactly its 1h target, t2 high at 3h of 4h
      resolved: 2, // t1, and t4 (created earlier, resolved inside the window)
      backlog: 3, // t2 pending, t3 and t5 open
      medianFirstResponseHours: 2, // median of 1h and 3h
      medianResolutionHours: 30, // median of 10h and 50h
    });
  });

  it("returns one point per day, oldest first, bucketed in UTC", async () => {
    const a = await getAnalytics(db, tenantA, 7, NOW);
    expect(a.daily.map((d) => d.date)).toEqual([
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
      "2026-10-20",
    ]);
    expect(a.daily.find((d) => d.date === "2026-10-15")).toEqual({
      date: "2026-10-15",
      created: 2,
      resolved: 1,
    });
    expect(a.daily.find((d) => d.date === "2026-10-14")).toEqual({
      date: "2026-10-14",
      created: 0,
      resolved: 1,
    });
    expect(a.daily.find((d) => d.date === "2026-10-20")?.created).toBe(1);
  });

  it("breaks tickets down by status (now), priority and category (window)", async () => {
    const a = await getAnalytics(db, tenantA, 7, NOW);
    expect(a.byStatus).toEqual([
      { key: "open", n: 2 },
      { key: "pending", n: 1 },
      { key: "resolved", n: 1 },
      { key: "closed", n: 1 },
    ]);
    expect(a.byPriority.map((r) => r.key)).toEqual(["urgent", "high", "normal", "low"]);
    expect(a.byPriority).toContainEqual({ key: "urgent", n: 1 });
    expect(a.byPriority).toContainEqual({ key: "normal", n: 1 }); // t3 defaults to normal
    expect(a.byPriority).toContainEqual({ key: "low", n: 0 }); // t4 is outside the window
    expect(a.byCategory).toContainEqual({ key: "untriaged", n: 1 });
    expect(a.byCategory).toContainEqual({ key: "billing", n: 1 });
  });

  it("counts AI drafts, triage, knowledge-base questions and tokens in the window only", async () => {
    const a = await getAnalytics(db, tenantA, 7, NOW);
    expect(a.drafts).toEqual({
      approved: 2,
      edited: 1,
      rejected: 1,
      pending: 1,
      total: 5,
      grounded: 4,
    });
    expect(a.triage).toEqual({ runs: 2, injections: 1, avgLatencyMs: 3000 });
    expect(a.kb).toEqual({ questions: 2, grounded: 1 });
    expect(a.tokens).toEqual({ input: 2000 + 1000 + 500, output: 100 + 80 + 50 });
  });

  it("lists open work by owner, most loaded first", async () => {
    const a = await getAnalytics(db, tenantA, 7, NOW);
    expect(a.workload).toEqual([
      { name: "Sam", n: 2 },
      { name: "Unassigned", n: 1 },
    ]);
  });

  it("never includes another tenant's data", async () => {
    const b = await getAnalytics(db, tenantB, 7, NOW);
    expect(b.tickets.created).toBe(1);
    expect(b.drafts.total).toBe(1);
    expect(b.triage).toMatchObject({ runs: 1, injections: 1 });
    expect(b.kb.questions).toBe(0);
  });
});

describe("parseRange", () => {
  it("accepts 7, 30 and 90 and defaults to 30", () => {
    expect([
      parseRange("7"),
      parseRange(90),
      parseRange(undefined),
      parseRange("365"),
      parseRange("x"),
    ]).toEqual([7, 90, 30, 30, 30]);
  });
});
