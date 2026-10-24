import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  customerAccounts,
  documentChunks,
  documents,
  EMBEDDING_DIMENSIONS,
  incidents,
  orders,
  ticketMessages,
  tickets,
} from "@/db/schema";
import { loadSeedData } from "../../seed/lib/load-data";
import { createTestDb, type TestDb } from "../db/test-db";
import { smallSeedData } from "./fixtures";

/** MOCK embedder: deterministic unit vectors instead of the real local model. */
const mockEmbed = async (texts: string[]) =>
  texts.map((_, i) =>
    Array.from({ length: EMBEDDING_DIMENSIONS }, (_, d) =>
      d === i % EMBEDDING_DIMENSIONS ? 1 : 0,
    ),
  );

let db: TestDb;
let close: () => Promise<void>;
const data = smallSeedData();

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close?.();
});

describe("loadSeedData", () => {
  it("loads every entity into the acme tenant with embedded chunks", async () => {
    const counts = await loadSeedData(db, data, { embedPassages: mockEmbed });

    expect(counts).toMatchObject({
      tenant: "acme",
      accounts: data.accounts.items.length,
      orders: data.orders.items.length,
      incidents: 1,
      documents: 3,
      tickets: data.tickets.items.length,
    });
    expect(await db.select().from(customerAccounts)).toHaveLength(data.accounts.items.length);
    expect(await db.select().from(orders)).toHaveLength(data.orders.items.length);

    const runbooks = await db.select().from(documents).where(eq(documents.kind, "runbook"));
    expect(runbooks.map((d) => d.externalRef)).toEqual(["RB-001"]);
    const chunks = await db.select().from(documentChunks);
    expect(chunks.length).toBe(counts.chunks);
    expect(chunks.every((c) => c.embedding?.length === EMBEDDING_DIMENSIONS)).toBe(true);
  });

  it("loads tickets untriaged, with messages, and linked to accounts and incidents", async () => {
    const rows = await db.select().from(tickets);
    expect(rows.every((t) => t.category === null && t.classifiedAt === null)).toBe(true);
    expect(rows.every((t) => t.customerAccountId !== null)).toBe(true);

    const [incident] = await db.select().from(incidents);
    const linked = rows.filter((t) => t.incidentId === incident.id);
    expect(linked.length).toBe(data.tickets.items.filter((t) => t.incidentRef).length);

    const messages = await db.select().from(ticketMessages);
    const expected = data.tickets.items.reduce((n, t) => n + (t.followUp ? 2 : 1), 0);
    expect(messages).toHaveLength(expected);
  });

  it("is idempotent and leaves rows created in the app untouched", async () => {
    const [anyTicket] = await db.select().from(tickets);
    // A ticket created in the app has no external_ref.
    const [appTicket] = await db
      .insert(tickets)
      .values({
        tenantId: anyTicket.tenantId,
        subject: "Created in the app",
        customerName: "Real",
        customerEmail: "real@customer.example",
      })
      .returning();

    await loadSeedData(db, data, { embedPassages: mockEmbed });

    expect(await db.select().from(tickets)).toHaveLength(data.tickets.items.length + 1);
    expect(await db.select().from(customerAccounts)).toHaveLength(data.accounts.items.length);
    expect(await db.select().from(documents)).toHaveLength(3);
    const kept = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, appTicket.id), isNull(tickets.externalRef)));
    expect(kept).toHaveLength(1);
  });

  it("rolls back everything if any insert fails", async () => {
    const before = await db.select().from(tickets);
    const broken = structuredClone(data);
    broken.tickets.items[0].accountRef = "ACC-9999"; // no such account -> null link is fine...
    broken.orders.items[0].accountRef = "ACC-9999"; // ...but an order without an account fails
    await expect(loadSeedData(db, broken, { embedPassages: mockEmbed })).rejects.toThrow();
    expect(await db.select().from(tickets)).toHaveLength(before.length);
  });
});
