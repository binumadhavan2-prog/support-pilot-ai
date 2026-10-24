import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLogs, tenants, ticketMessages, user } from "@/db/schema";
import {
  addAgentReply,
  createTicket,
  getTicket,
  listAssignableUsers,
  listTickets,
  listTicketsQuerySchema,
  updateTicket,
  updateTicketSchema,
} from "@/server/tickets";
import { createTestDb, type TestDb } from "./test-db";

/* Status changes, assignment and agent replies on PGlite. */

let db: TestDb;
let close: () => Promise<void>;
let tenantA: string;
let tenantB: string;
const sam = { type: "user" as const, userId: "agent_sam" };

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
    { id: "agent_sam", tenantId: tenantA, name: "Sam", email: "sam@a.test", role: "agent" },
    { id: "admin_ava", tenantId: tenantA, name: "Ava", email: "ava@a.test", role: "admin" },
    { id: "viewer_vic", tenantId: tenantA, name: "Vic", email: "vic@a.test", role: "viewer" },
    {
      id: "agent_ban",
      tenantId: tenantA,
      name: "Ben",
      email: "ben@a.test",
      role: "agent",
      banned: true,
    },
    { id: "agent_bo", tenantId: tenantB, name: "Bo", email: "bo@b.test", role: "agent" },
  ]);
});

afterAll(async () => {
  await close?.();
});

async function ticket(subject = "Export broken", tenantId = tenantA) {
  return createTicket(
    db,
    tenantId,
    {
      subject,
      body: "The export button does nothing.",
      customer: { name: "Dana", email: "dana@x.test" },
    },
    { actor: { type: "api_key", apiKeyId: "00000000-0000-4000-8000-000000000001" }, source: "api" },
  );
}

describe("updateTicket", () => {
  it("changes status, stamps resolved_at on resolve and clears it on reopen, with audit rows", async () => {
    const t = await ticket();
    await updateTicket(
      db,
      { tenantId: tenantA, ticketId: t.id, actor: sam },
      { status: "resolved" },
    );
    const resolved = await getTicket(db, tenantA, t.id);
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedAt).toBeInstanceOf(Date);

    await updateTicket(db, { tenantId: tenantA, ticketId: t.id, actor: sam }, { status: "closed" });
    // Closing keeps the original resolution time.
    expect((await getTicket(db, tenantA, t.id)).resolvedAt).toEqual(resolved.resolvedAt);

    await updateTicket(db, { tenantId: tenantA, ticketId: t.id, actor: sam }, { status: "open" });
    expect((await getTicket(db, tenantA, t.id)).resolvedAt).toBeNull();

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, t.id), eq(auditLogs.action, "ticket.updated")));
    expect(audits.map((a) => a.metadata.status)).toEqual([
      { from: "open", to: "resolved" },
      { from: "resolved", to: "closed" },
      { from: "closed", to: "open" },
    ]);
    expect(audits.every((a) => a.actorId === "agent_sam")).toBe(true);
  });

  it("assigns to active agents and admins in the tenant only, and unassigns", async () => {
    const t = await ticket();
    const ctx = { tenantId: tenantA, ticketId: t.id, actor: sam };
    await updateTicket(db, ctx, { assigneeId: "admin_ava" });
    expect((await getTicket(db, tenantA, t.id)).assigneeId).toBe("admin_ava");

    for (const assigneeId of ["viewer_vic", "agent_ban", "agent_bo", "nobody"]) {
      await expect(updateTicket(db, ctx, { assigneeId })).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: "Choose an agent or admin in your team",
      });
    }
    await updateTicket(db, ctx, { assigneeId: null });
    expect((await getTicket(db, tenantA, t.id)).assigneeId).toBeNull();
  });

  it("reports no change without writing an audit row", async () => {
    const t = await ticket();
    const result = await updateTicket(
      db,
      { tenantId: tenantA, ticketId: t.id, actor: sam },
      { status: "open", assigneeId: null },
    );
    expect(result.changed).toBe(false);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, t.id), eq(auditLogs.action, "ticket.updated")));
    expect(audits).toHaveLength(0);
  });

  it("can't touch another tenant's ticket", async () => {
    const t = await ticket("B's ticket", tenantB);
    await expect(
      updateTicket(db, { tenantId: tenantA, ticketId: t.id, actor: sam }, { status: "closed" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await getTicket(db, tenantB, t.id)).status).toBe("open");
  });

  it("requires at least one field", () => {
    expect(updateTicketSchema.safeParse({}).success).toBe(false);
    expect(updateTicketSchema.safeParse({ status: "everything" }).success).toBe(false);
  });
});

describe("addAgentReply", () => {
  it("adds the agent's message, sets first response, and moves an open ticket to pending", async () => {
    const t = await ticket();
    await addAgentReply(
      db,
      { tenantId: tenantA, ticketId: t.id, authorId: "agent_sam" },
      { body: "  Fixed it!  " },
    );
    const detail = await getTicket(db, tenantA, t.id);
    expect(detail.status).toBe("pending");
    expect(detail.firstResponseAt).toBeInstanceOf(Date);
    expect(detail.messages.at(-1)).toMatchObject({
      authorType: "agent",
      authorName: "Sam",
      body: "Fixed it!",
      sourceDraftId: null,
    });
  });

  it("rejects an empty reply and another tenant's ticket", async () => {
    const t = await ticket();
    await expect(
      addAgentReply(
        db,
        { tenantId: tenantA, ticketId: t.id, authorId: "agent_sam" },
        { body: "   " },
      ),
    ).rejects.toThrow();
    const other = await ticket("B", tenantB);
    await expect(
      addAgentReply(
        db,
        { tenantId: tenantA, ticketId: other.id, authorId: "agent_sam" },
        { body: "hi" },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      await db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, other.id)),
    ).toHaveLength(1);
  });
});

describe("assignee filter and assignable users", () => {
  it("filters by me, unassigned and a specific user, and shows the assignee's name", async () => {
    const mine = await ticket("Mine");
    await updateTicket(
      db,
      { tenantId: tenantA, ticketId: mine.id, actor: sam },
      { assigneeId: "agent_sam" },
    );
    const q = (assignee: string) => listTicketsQuerySchema.parse({ assignee, pageSize: 100 });

    const me = await listTickets(db, tenantA, q("me"), { viewerId: "agent_sam" });
    expect(me.items.map((t) => t.id)).toEqual([mine.id]);
    expect(me.items[0].assigneeName).toBe("Sam");

    const unassigned = await listTickets(db, tenantA, q("unassigned"));
    expect(unassigned.items.every((t) => t.assigneeId === null)).toBe(true);
    expect(unassigned.items.map((t) => t.id)).not.toContain(mine.id);

    expect((await listTickets(db, tenantA, q("agent_sam"))).total).toBe(1);
    // An API key has no "me": nothing matches rather than everything.
    expect((await listTickets(db, tenantA, q("me"))).total).toBe(0);
  });

  it("lists only active agents and admins of the tenant", async () => {
    const users = await listAssignableUsers(db, tenantA);
    expect(users.map((u) => u.id)).toEqual(["admin_ava", "agent_sam"]);
  });
});
