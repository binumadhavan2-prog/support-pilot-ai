import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EMBEDDING_DIMENSIONS,
  aiDrafts,
  apiKeys,
  answerEvaluations,
  citations,
  customerAccounts,
  documentChunks,
  documents,
  incidents,
  orders,
  tenants,
  ticketMessages,
  tickets,
  toolCalls,
  triageResults,
  user,
} from "@/db/schema";
import { createTestDb, type TestDb } from "./test-db";

let db: TestDb;
let close: () => Promise<void>;
// Most tests run in tenant A; isolation tests also use tenant B.
let tenantA: string;
let tenantB: string;

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
});

afterAll(async () => {
  await close?.();
});

/** One-hot unit vector, so cosine distances between test vectors are predictable. */
const unitVector = (hot: number) =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === hot ? 1 : 0));

async function insertTicket(subject = "Cannot reset my password", tenantId = tenantA) {
  const [ticket] = await db
    .insert(tickets)
    .values({
      tenantId,
      subject,
      customerName: "Test Customer",
      customerEmail: "customer@example.test",
    })
    .returning();
  return ticket;
}

async function insertDocument(contentHash: string, tenantId = tenantA) {
  const [doc] = await db
    .insert(documents)
    .values({
      tenantId,
      title: "Refund policy",
      filename: "refunds.md",
      mimeType: "text/markdown",
      sizeBytes: 120,
      contentHash,
    })
    .returning();
  return doc;
}

describe("migrations", () => {
  it("apply cleanly and enable pgvector", async () => {
    const result = await db.execute<{ extname: string }>(
      sql`select extname from pg_extension where extname = 'vector'`,
    );
    expect(result.rows).toHaveLength(1);
  });

  it("enable row level security on every public table", async () => {
    // Guards against a new table being exposed through Supabase's Data API (see migration 0002).
    const result = await db.execute<{ relname: string }>(
      sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(result.rows.map((r) => r.relname)).toEqual([]);
  });
});

describe("users", () => {
  it("default to the least-privileged viewer role", async () => {
    const [created] = await db
      .insert(user)
      .values({ id: "user_viewer", tenantId: tenantA, name: "Vee", email: "viewer@example.test" })
      .returning();
    expect(created.role).toBe("viewer");
    expect(created.banned).toBe(false);
  });

  it("reject duplicate emails", async () => {
    await expect(
      db
        .insert(user)
        .values({ id: "user_dup", tenantId: tenantB, name: "Dup", email: "viewer@example.test" }),
    ).rejects.toThrow();
  });
});

describe("tickets", () => {
  it("get sequential human-friendly numbers starting at 1000 and sensible defaults", async () => {
    const first = await insertTicket();
    const second = await insertTicket("Billing question");
    expect(first.number).toBeGreaterThanOrEqual(1000);
    expect(second.number).toBe(first.number + 1);
    expect(first.status).toBe("open");
    expect(first.priority).toBe("normal");
    expect(first.category).toBeNull();
  });

  it("cascade-delete their messages and drafts", async () => {
    const ticket = await insertTicket("To be deleted");
    await db
      .insert(ticketMessages)
      .values({ tenantId: tenantA, ticketId: ticket.id, authorType: "customer", body: "hi" });
    await db.insert(aiDrafts).values({
      tenantId: tenantA,
      ticketId: ticket.id,
      body: "draft",
      groundingStatus: "grounded",
      model: "test-model",
    });

    await db.delete(tickets).where(eq(tickets.id, ticket.id));

    expect(
      await db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, ticket.id)),
    ).toEqual([]);
    expect(await db.select().from(aiDrafts).where(eq(aiDrafts.ticketId, ticket.id))).toEqual([]);
  });

  it("unassign (not delete) when the assignee user is deleted", async () => {
    await db.insert(user).values({
      id: "user_agent",
      tenantId: tenantA,
      name: "Agent",
      email: "agent@example.test",
      role: "agent",
    });
    const ticket = await insertTicket("Assigned ticket");
    await db.update(tickets).set({ assigneeId: "user_agent" }).where(eq(tickets.id, ticket.id));

    await db.delete(user).where(eq(user.id, "user_agent"));

    const [after] = await db.select().from(tickets).where(eq(tickets.id, ticket.id));
    expect(after.assigneeId).toBeNull();
  });
});

describe("knowledge base", () => {
  it("rejects ingesting the same file twice in one tenant, but allows it in another", async () => {
    await insertDocument("hash-dup");
    await expect(insertDocument("hash-dup")).rejects.toThrow();
    await expect(insertDocument("hash-dup", tenantB)).resolves.toBeDefined();
  });

  it("maintains a generated full-text search vector on chunks", async () => {
    const doc = await insertDocument("hash-fts");
    await db.insert(documentChunks).values([
      {
        tenantId: tenantA,
        documentId: doc.id,
        chunkIndex: 0,
        tokenCount: 12,
        content: "Refunds are issued within 14 days of purchase.",
      },
      {
        tenantId: tenantA,
        documentId: doc.id,
        chunkIndex: 1,
        tokenCount: 9,
        content: "Shipping takes three to five business days.",
      },
    ]);

    const hits = await db
      .select({ chunkIndex: documentChunks.chunkIndex })
      .from(documentChunks)
      .where(sql`${documentChunks.searchVector} @@ plainto_tsquery('english', 'refund purchase')`);

    expect(hits).toEqual([{ chunkIndex: 0 }]);
  });

  it("orders chunks by cosine distance to a query embedding", async () => {
    const doc = await insertDocument("hash-vec");
    await db.insert(documentChunks).values([
      {
        tenantId: tenantA,
        documentId: doc.id,
        chunkIndex: 0,
        tokenCount: 1,
        content: "alpha",
        embedding: unitVector(0),
      },
      {
        tenantId: tenantA,
        documentId: doc.id,
        chunkIndex: 1,
        tokenCount: 1,
        content: "beta",
        embedding: unitVector(1),
      },
      // Chunks without an embedding (no provider configured) must not break vector queries.
      { tenantId: tenantA, documentId: doc.id, chunkIndex: 2, tokenCount: 1, content: "gamma" },
    ]);

    const query = JSON.stringify(unitVector(1));
    const ranked = await db
      .select({
        content: documentChunks.content,
        distance: sql<number>`${documentChunks.embedding} <=> ${query}::vector`,
      })
      .from(documentChunks)
      .where(
        sql`${documentChunks.documentId} = ${doc.id} and ${documentChunks.embedding} is not null`,
      )
      .orderBy(sql`${documentChunks.embedding} <=> ${query}::vector`);

    expect(ranked.map((r) => r.content)).toEqual(["beta", "alpha"]);
    expect(Number(ranked[0].distance)).toBeCloseTo(0);
  });

  it("rejects embeddings with the wrong dimension", async () => {
    const doc = await insertDocument("hash-dim");
    await expect(
      db.insert(documentChunks).values({
        tenantId: tenantA,
        documentId: doc.id,
        chunkIndex: 0,
        tokenCount: 1,
        content: "x",
        embedding: [1, 0, 0],
      }),
    ).rejects.toThrow();
  });

  it("rejects two chunks with the same index in one document", async () => {
    const doc = await insertDocument("hash-idx");
    await db.insert(documentChunks).values({
      tenantId: tenantA,
      documentId: doc.id,
      chunkIndex: 0,
      tokenCount: 1,
      content: "a",
    });
    await expect(
      db.insert(documentChunks).values({
        tenantId: tenantA,
        documentId: doc.id,
        chunkIndex: 0,
        tokenCount: 1,
        content: "b",
      }),
    ).rejects.toThrow();
  });
});

describe("citations and evaluations", () => {
  async function insertDraft() {
    const ticket = await insertTicket("Needs a draft");
    const [draft] = await db
      .insert(aiDrafts)
      .values({
        tenantId: tenantA,
        ticketId: ticket.id,
        body: "Refunds take 14 days [1].",
        groundingStatus: "grounded",
        model: "test-model",
      })
      .returning();
    return draft;
  }

  it("keep the quote snapshot when the source chunk is deleted", async () => {
    const draft = await insertDraft();
    const doc = await insertDocument("hash-cite");
    const [chunk] = await db
      .insert(documentChunks)
      .values({
        tenantId: tenantA,
        documentId: doc.id,
        chunkIndex: 0,
        tokenCount: 5,
        content: "Refunds within 14 days.",
      })
      .returning();
    const [citation] = await db
      .insert(citations)
      .values({
        tenantId: tenantA,
        draftId: draft.id,
        chunkId: chunk.id,
        position: 1,
        documentTitle: doc.title,
        quote: chunk.content,
        score: 0.9,
      })
      .returning();

    await db.delete(documents).where(eq(documents.id, doc.id));

    const [after] = await db.select().from(citations).where(eq(citations.id, citation.id));
    expect(after.chunkId).toBeNull();
    expect(after.quote).toBe("Refunds within 14 days.");
  });

  it("require exactly one target (draft or query)", async () => {
    await expect(
      db
        .insert(citations)
        .values({ tenantId: tenantA, position: 1, documentTitle: "t", quote: "q", score: 0.5 }),
    ).rejects.toThrow();
  });

  it("reject scores outside [0, 1]", async () => {
    const draft = await insertDraft();
    await expect(
      db.insert(citations).values({
        tenantId: tenantA,
        draftId: draft.id,
        position: 1,
        documentTitle: "t",
        quote: "q",
        score: 1.5,
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(answerEvaluations).values({
        tenantId: tenantA,
        draftId: draft.id,
        evaluator: "llm_judge",
        groundedness: -0.1,
      }),
    ).rejects.toThrow();
  });

  it("accept a valid evaluation", async () => {
    const draft = await insertDraft();
    const [evaluation] = await db
      .insert(answerEvaluations)
      .values({
        tenantId: tenantA,
        draftId: draft.id,
        evaluator: "llm_judge",
        groundedness: 1,
        relevance: 0.8,
        citationAccuracy: 0.9,
        model: "judge-model",
      })
      .returning();
    expect(evaluation.groundedness).toBe(1);
  });
});

describe("tenant isolation (enforced by the database)", () => {
  it("rejects a message whose tenant differs from its ticket's", async () => {
    const ticket = await insertTicket("Tenant A ticket");
    await expect(
      db
        .insert(ticketMessages)
        .values({ tenantId: tenantB, ticketId: ticket.id, authorType: "customer", body: "x" }),
    ).rejects.toThrow();
  });

  it("rejects assigning a ticket to a user from another tenant", async () => {
    await db
      .insert(user)
      .values({ id: "user_b", tenantId: tenantB, name: "B", email: "b@example.test" });
    const ticket = await insertTicket("Cross-tenant assignee");
    await expect(
      db.update(tickets).set({ assigneeId: "user_b" }).where(eq(tickets.id, ticket.id)),
    ).rejects.toThrow();
  });

  it("rejects an API key created by a user from another tenant", async () => {
    // user_b (tenant B) is created by the previous test.
    const key = { name: "Webhook", prefix: "sp_x", createdById: "user_b" };
    await expect(
      db.insert(apiKeys).values({ ...key, tenantId: tenantA, keyHash: "hash-a" }),
    ).rejects.toThrow();
    await expect(
      db.insert(apiKeys).values({ ...key, tenantId: tenantB, keyHash: "hash-b" }),
    ).resolves.toBeDefined();
  });

  it("rejects chunks, drafts and citations that point into another tenant", async () => {
    const docA = await insertDocument("hash-iso");
    await expect(
      db.insert(documentChunks).values({
        tenantId: tenantB,
        documentId: docA.id,
        chunkIndex: 0,
        tokenCount: 1,
        content: "x",
      }),
    ).rejects.toThrow();

    const ticketA = await insertTicket("Draft isolation");
    await expect(
      db.insert(aiDrafts).values({
        tenantId: tenantB,
        ticketId: ticketA.id,
        body: "x",
        groundingStatus: "grounded",
        model: "m",
      }),
    ).rejects.toThrow();

    const [chunkA] = await db
      .insert(documentChunks)
      .values({
        tenantId: tenantA,
        documentId: docA.id,
        chunkIndex: 0,
        tokenCount: 1,
        content: "a",
      })
      .returning();
    const ticketB = await insertTicket("Tenant B ticket", tenantB);
    const [draftB] = await db
      .insert(aiDrafts)
      .values({
        tenantId: tenantB,
        ticketId: ticketB.id,
        body: "x",
        groundingStatus: "grounded",
        model: "m",
      })
      .returning();
    await expect(
      db.insert(citations).values({
        tenantId: tenantB,
        draftId: draftB.id,
        chunkId: chunkA.id,
        position: 1,
        documentTitle: "t",
        quote: "q",
        score: 0.5,
      }),
    ).rejects.toThrow();
  });

  it("still clears (not deletes) a same-tenant reference when its target is deleted", async () => {
    const [incident] = await db
      .insert(incidents)
      .values({
        tenantId: tenantA,
        title: "Gateway outage",
        severity: "sev2",
        startedAt: new Date(),
      })
      .returning();
    const ticket = await insertTicket("Linked to incident");
    await db.update(tickets).set({ incidentId: incident.id }).where(eq(tickets.id, ticket.id));

    await db.delete(incidents).where(eq(incidents.id, incident.id));

    const [after] = await db.select().from(tickets).where(eq(tickets.id, ticket.id));
    expect(after.incidentId).toBeNull();
    expect(after.tenantId).toBe(tenantA);
  });

  it("refuses to delete a tenant that still owns data", async () => {
    await expect(db.delete(tenants).where(eq(tenants.id, tenantA))).rejects.toThrow();
  });

  it("rejects malformed tenant slugs", async () => {
    await expect(db.insert(tenants).values({ slug: "Bad Slug!", name: "x" })).rejects.toThrow();
  });
});

describe("customers and orders", () => {
  it("cascade-delete orders with their account and reject cross-tenant orders", async () => {
    const [account] = await db
      .insert(customerAccounts)
      .values({
        tenantId: tenantA,
        externalRef: "ACC-1",
        companyName: "Globex",
        contactName: "Hank",
        contactEmail: "hank@globex.test",
        plan: "pro",
        status: "active",
      })
      .returning();
    const order = {
      externalRef: "INV-1",
      accountId: account.id,
      description: "Pro plan, monthly",
      amountCents: 4900,
      status: "paid",
      orderedAt: new Date(),
    };
    await expect(db.insert(orders).values({ ...order, tenantId: tenantB })).rejects.toThrow();
    await db.insert(orders).values({ ...order, tenantId: tenantA });

    await db.delete(customerAccounts).where(eq(customerAccounts.id, account.id));
    expect(await db.select().from(orders).where(eq(orders.accountId, account.id))).toEqual([]);
  });
});

describe("triage results and tool calls", () => {
  it("reject triage confidence outside [0, 1]", async () => {
    const ticket = await insertTicket("Triage me");
    const triage = {
      tenantId: tenantA,
      ticketId: ticket.id,
      category: "billing" as const,
      priority: "high" as const,
      sentiment: "negative" as const,
      language: "hinglish",
      summary: "Double charge",
      model: "m",
    };
    await expect(db.insert(triageResults).values({ ...triage, confidence: 1.2 })).rejects.toThrow();
    const [row] = await db
      .insert(triageResults)
      .values({ ...triage, confidence: 0.9 })
      .returning();
    expect(row.isInjection).toBe(false);
  });

  it("start pending, and require review / execution timestamps for later states", async () => {
    const ticket = await insertTicket("Refund request");
    const base = { tenantId: tenantA, ticketId: ticket.id, toolName: "refund_order" };

    const [pending] = await db.insert(toolCalls).values(base).returning();
    expect(pending.status).toBe("pending");

    await expect(db.insert(toolCalls).values({ ...base, status: "approved" })).rejects.toThrow();
    await expect(
      db.insert(toolCalls).values({ ...base, status: "executed", reviewedAt: new Date() }),
    ).rejects.toThrow();
    await expect(
      db.insert(toolCalls).values({
        ...base,
        status: "executed",
        reviewedAt: new Date(),
        executedAt: new Date(),
      }),
    ).resolves.toBeDefined();
  });
});
