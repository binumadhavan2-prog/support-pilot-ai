import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLogs, tenants, tickets, user } from "@/db/schema";
import {
  createIncident,
  getIncident,
  linkTicket,
  listIncidents,
  unlinkTicket,
  updateIncident,
  updateIncidentSchema,
} from "@/server/incidents";
import { createTicket, getTicket, updateTicket } from "@/server/tickets";
import { createTestDb, type TestDb } from "./test-db";

/* Incidents and ticket linking on PGlite. */

let db: TestDb;
let close: () => Promise<void>;
let tenantA: string;
let tenantB: string;
const apiActor = { type: "api_key" as const, apiKeyId: "00000000-0000-4000-8000-000000000001" };
const sam = (tenantId = tenantA) => ({ tenantId, actorId: "agent_sam" });

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

async function ticket(subject = "Payments failing", tenantId = tenantA) {
  return createTicket(
    db,
    tenantId,
    { subject, body: "Card payments fail.", customer: { name: "Dana", email: "dana@x.test" } },
    { actor: apiActor, source: "api" },
  );
}

async function numberOf(ticketId: string) {
  const [row] = await db
    .select({ number: tickets.number })
    .from(tickets)
    .where(eq(tickets.id, ticketId));
  return row.number;
}

describe("incidents", () => {
  it("creates an incident with an audit row", async () => {
    const { id } = await createIncident(db, sam(), {
      title: "  Payment gateway outage ",
      severity: "sev1",
      summary: "",
    });
    const incident = await getIncident(db, tenantA, id);
    expect(incident).toMatchObject({
      title: "Payment gateway outage",
      severity: "sev1",
      status: "open",
      summary: null,
      isDemo: false,
      tickets: [],
    });
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "incident.created")));
    expect(audit).toMatchObject({ actorId: "agent_sam", metadata: { severity: "sev1" } });
  });

  it("stamps resolved_at on resolve and clears it on reopen", async () => {
    const { id } = await createIncident(db, sam(), { title: "Slow API", severity: "sev3" });
    const ctx = { ...sam(), incidentId: id };
    expect(await updateIncident(db, ctx, { status: "resolved" })).toEqual({ changed: true });
    expect((await getIncident(db, tenantA, id)).resolvedAt).toBeInstanceOf(Date);
    await updateIncident(db, ctx, { status: "investigating", severity: "sev2" });
    const reopened = await getIncident(db, tenantA, id);
    expect(reopened).toMatchObject({ status: "investigating", severity: "sev2", resolvedAt: null });
    expect(await updateIncident(db, ctx, { status: "investigating" })).toEqual({ changed: false });
  });

  it("keeps summary text out of the audit log", async () => {
    const { id } = await createIncident(db, sam(), { title: "DNS", severity: "sev2" });
    await updateIncident(db, { ...sam(), incidentId: id }, { summary: "Customer data in here" });
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "incident.updated")));
    expect(audit.metadata).toEqual({ summary: { from: false, to: true } });
  });

  it("rejects an empty update and an invalid title", async () => {
    expect(updateIncidentSchema.safeParse({}).success).toBe(false);
    await expect(createIncident(db, sam(), { title: " ", severity: "sev1" })).rejects.toThrow();
  });

  it("links tickets by number, counts open ones, and shows the incident on the ticket", async () => {
    const { id } = await createIncident(db, sam(), { title: "Checkout down", severity: "sev1" });
    const ctx = { ...sam(), incidentId: id };
    const t1 = await ticket("Can't pay");
    const t2 = await ticket("Payment error");
    await linkTicket(db, ctx, { ticketNumber: await numberOf(t1.id) });
    await linkTicket(db, ctx, { ticketNumber: String(await numberOf(t2.id)) });
    await updateTicket(
      db,
      { tenantId: tenantA, ticketId: t2.id, actor: { type: "user", userId: "agent_sam" } },
      { status: "resolved" },
    );

    const listed = (await listIncidents(db, tenantA)).find((i) => i.id === id);
    expect(listed).toMatchObject({ ticketCount: 2, openTicketCount: 1 });
    expect((await getIncident(db, tenantA, id)).tickets.map((t) => t.id).sort()).toEqual(
      [t1.id, t2.id].sort(),
    );
    expect((await getTicket(db, tenantA, t1.id)).incident).toEqual({
      id,
      title: "Checkout down",
      status: "open",
    });

    // Linking again is a no-op; unlinking removes it.
    expect(await linkTicket(db, ctx, { ticketNumber: await numberOf(t1.id) })).toMatchObject({
      changed: false,
    });
    await unlinkTicket(db, ctx, { ticketId: t1.id });
    expect((await getTicket(db, tenantA, t1.id)).incident).toBeNull();
    await expect(unlinkTicket(db, ctx, { ticketId: t1.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("moves a ticket from its previous incident", async () => {
    const first = await createIncident(db, sam(), { title: "First", severity: "sev3" });
    const second = await createIncident(db, sam(), { title: "Second", severity: "sev3" });
    const t = await ticket();
    const number = await numberOf(t.id);
    await linkTicket(db, { ...sam(), incidentId: first.id }, { ticketNumber: number });
    await linkTicket(db, { ...sam(), incidentId: second.id }, { ticketNumber: number });
    expect((await getIncident(db, tenantA, first.id)).tickets).toHaveLength(0);
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityId, t.id),
          eq(auditLogs.action, "ticket.incident_linked"),
          eq(auditLogs.metadata, { incidentId: second.id, previousIncidentId: first.id }),
        ),
      );
    expect(audit).toBeDefined();
  });

  it("lists active incidents before resolved ones", async () => {
    const resolved = await createIncident(db, sam(), { title: "Old", severity: "sev4" });
    await updateIncident(db, { ...sam(), incidentId: resolved.id }, { status: "resolved" });
    const active = await createIncident(db, sam(), { title: "Now", severity: "sev4" });
    const ids = (await listIncidents(db, tenantA)).map((i) => i.id);
    expect(ids.indexOf(active.id)).toBeLessThan(ids.indexOf(resolved.id));
  });

  it("keeps tenants apart", async () => {
    const mine = await createIncident(db, sam(), { title: "A's incident", severity: "sev2" });
    const theirs = await createIncident(db, sam(tenantB), { title: "B's", severity: "sev2" });
    const theirTicket = await ticket("B's ticket", tenantB);

    await expect(getIncident(db, tenantA, theirs.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      updateIncident(db, { ...sam(), incidentId: theirs.id }, { status: "resolved" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A ticket number from another tenant is not found, so it can't be linked.
    await expect(
      linkTicket(
        db,
        { ...sam(), incidentId: mine.id },
        { ticketNumber: await numberOf(theirTicket.id) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listIncidents(db, tenantA)).some((i) => i.id === theirs.id)).toBe(false);
    await expect(getIncident(db, tenantA, "not-a-uuid")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
