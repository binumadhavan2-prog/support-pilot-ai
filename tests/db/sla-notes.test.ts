import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLogs, tenants, ticketMessages, tickets, user } from "@/db/schema";
import { getAnalytics } from "@/server/analytics";
import { ticketSla } from "@/server/sla";
import {
  addAgentReply,
  addInternalNote,
  createTicket,
  getTicket,
  listTickets,
  listTicketsQuerySchema,
} from "@/server/tickets";
import { createTestDb, type TestDb } from "./test-db";

/* SLA filters and analytics (SQL) against the same rules in code, and internal notes, on PGlite. */

let db: TestDb;
let close: () => Promise<void>;
let tenantA: string;
let tenantB: string;
const HOUR = 3_600_000;
const apiActor = { type: "api_key" as const, apiKeyId: "00000000-0000-4000-8000-000000000001" };

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
  await db
    .insert(user)
    .values([
      { id: "agent_sam", tenantId: tenantA, name: "Sam", email: "sam@a.test", role: "agent" },
    ]);
});

afterAll(async () => {
  await close?.();
});

/** A ticket created `hoursAgo` hours ago with the given priority. */
async function ticketAged(
  hoursAgo: number,
  priority: "urgent" | "high" | "normal" | "low",
  tenantId = tenantA,
) {
  const t = await createTicket(
    db,
    tenantId,
    {
      subject: `Aged ${hoursAgo}h ${priority}`,
      body: "Help",
      customer: { name: "D", email: "d@x.test" },
    },
    { actor: apiActor, source: "api" },
  );
  await db
    .update(tickets)
    .set({ priority, createdAt: new Date(Date.now() - hoursAgo * HOUR) })
    .where(eq(tickets.id, t.id));
  return t.id;
}

const ids = async (sla: "overdue" | "at_risk", tenantId = tenantA) =>
  (await listTickets(db, tenantId, listTicketsQuerySchema.parse({ sla, pageSize: 100 }))).items.map(
    (t) => t.id,
  );

describe("SLA", () => {
  it("filters overdue and at-risk tickets in SQL, agreeing with the rules in code", async () => {
    const overdue = await ticketAged(2, "urgent"); // 1h first-response target
    const atRisk = await ticketAged(7, "normal"); // 8h target: 1h left
    const fine = await ticketAged(1, "low"); // 24h target
    const answered = await ticketAged(2, "urgent");
    await addAgentReply(
      db,
      { tenantId: tenantA, ticketId: answered, authorId: "agent_sam" },
      {
        body: "On it",
      },
    );
    await ticketAged(5, "urgent", tenantB); // other tenant: never listed

    const overdueIds = await ids("overdue");
    const atRiskIds = await ids("at_risk");
    expect(overdueIds).toContain(overdue);
    expect(overdueIds).not.toContain(atRisk);
    expect(atRiskIds).toContain(atRisk);
    expect([...overdueIds, ...atRiskIds]).not.toContain(fine);
    // Answered late enough? It was answered right away (on time), and resolution (8h) still runs.
    expect(overdueIds).not.toContain(answered);

    // The code says the same for every listed ticket.
    const now = new Date();
    for (const id of overdueIds) {
      const sla = ticketSla(await getTicket(db, tenantA, id), now);
      expect([sla.firstResponse.state, sla.resolution.state]).toContain("breached");
    }
  });

  it("counts first replies within SLA for analytics", async () => {
    const onTime = await ticketAged(3, "high"); // 4h target, answered now: within
    const late = await ticketAged(10, "normal"); // 8h target, answered now: late
    for (const ticketId of [onTime, late]) {
      await addAgentReply(
        db,
        { tenantId: tenantA, ticketId, authorId: "agent_sam" },
        { body: "Hi" },
      );
    }
    const before = (await getAnalytics(db, tenantA, 7)).tickets;
    expect(before.answeredWithinSla).toBeLessThan(before.answered);
    const [lateRow] = await db.select().from(tickets).where(eq(tickets.id, late));
    expect(ticketSla(lateRow, new Date()).firstResponse.state).toBe("breached");
  });
});

describe("internal notes", () => {
  it("are kept from the customer: no email, no first response, no status change", async () => {
    const NOTE = "Customer is on the old plan; check billing first.";
    const id = await ticketAged(0, "normal");
    const note = await addInternalNote(
      db,
      { tenantId: tenantA, ticketId: id, authorId: "agent_sam" },
      { body: NOTE },
    );

    const ticket = await getTicket(db, tenantA, id);
    expect(ticket).toMatchObject({ status: "open", firstResponseAt: null });
    const saved = ticket.messages.find((m) => m.id === note.id)!;
    expect(saved).toMatchObject({ internal: true, authorType: "agent", emailStatus: null });

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "ticket.note_added")));
    expect(audit.metadata).toEqual({ messageId: note.id, length: NOTE.length }); // never the text
  });

  it("rejects empty notes and other tenants' tickets", async () => {
    const id = await ticketAged(0, "normal");
    await expect(
      addInternalNote(
        db,
        { tenantId: tenantA, ticketId: id, authorId: "agent_sam" },
        { body: " " },
      ),
    ).rejects.toThrow();
    const theirs = await ticketAged(0, "normal", tenantB);
    await expect(
      addInternalNote(
        db,
        { tenantId: tenantA, ticketId: theirs, authorId: "agent_sam" },
        { body: "Peek" },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const notes = await db
      .select()
      .from(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, theirs), eq(ticketMessages.internal, true)));
    expect(notes).toHaveLength(0);
  });
});
