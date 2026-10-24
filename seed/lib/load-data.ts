import { createHash } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import {
  customerAccounts,
  documentChunks,
  documents,
  incidents,
  orders,
  ticketMessages,
  tickets,
} from "@/db/schema";
import type { AnyDatabase } from "@/db/types";
import { chunkMarkdown } from "@/server/knowledge/chunk";
import { ensureTenant } from "@/server/tenants";
import { DEMO_TENANT } from "./demo-tenant";
import type { SeedData } from "./schemas";

export type EmbedPassages = (texts: string[]) => Promise<number[][]>;

const HOUR = 60 * 60 * 1000;

/**
 * Loads the DEMO DATA into the "acme" tenant. Idempotent: seed-owned rows (those with an
 * `external_ref`) are replaced on every run; rows created in the app (no external_ref) and users
 * are never touched. Tickets load untriaged: the labels stay in seed/data and the eval set, so
 * the AI has real work to do and cannot see the answers.
 */
export async function loadSeedData(
  db: AnyDatabase,
  data: SeedData,
  { embedPassages, log = () => {} }: { embedPassages: EmbedPassages; log?: (m: string) => void },
) {
  const tenant = await ensureTenant(db, DEMO_TENANT);

  // Chunk and embed before opening the transaction, so it stays short.
  const docs = [
    ...data.kbArticles.items.map((a) => ({ ...a, kind: "article" as const })),
    ...data.runbooks.items.map((r) => ({ ...r, kind: "runbook" as const })),
  ].map((doc) => ({ doc, chunks: chunkMarkdown(doc.title, doc.body) }));
  const allChunks = docs.flatMap((d) => d.chunks.map((c) => c.content));
  log(`embedding ${allChunks.length} chunks from ${docs.length} documents`);
  const vectors = await embedPassages(allChunks);
  if (vectors.length !== allChunks.length) throw new Error("Embedder returned the wrong count");

  return db.transaction(async (tx) => {
    const seeded = <
      T extends typeof tickets | typeof documents | typeof incidents | typeof customerAccounts,
    >(
      table: T,
    ) => and(eq(table.tenantId, tenant.id), isNotNull(table.externalRef));
    // Children cascade: messages/drafts/triage with tickets, chunks with documents, orders with accounts.
    await tx.delete(tickets).where(seeded(tickets));
    await tx.delete(documents).where(seeded(documents));
    await tx.delete(incidents).where(seeded(incidents));
    await tx.delete(customerAccounts).where(seeded(customerAccounts));

    const accountIds = new Map<string, string>();
    for (const a of data.accounts.items) {
      const [row] = await tx
        .insert(customerAccounts)
        .values({
          tenantId: tenant.id,
          externalRef: a.ref,
          companyName: a.companyName,
          contactName: a.contactName,
          contactEmail: a.contactEmail,
          plan: a.plan,
          status: a.status,
          mrrCents: a.mrrCents,
          currency: a.currency,
          metadata: {
            billingCycle: a.billingCycle,
            region: a.region,
            country: a.country,
            city: a.city,
            industry: a.industry,
          },
          createdAt: new Date(a.createdAt),
        })
        .returning({ id: customerAccounts.id });
      accountIds.set(a.ref, row.id);
    }

    if (data.orders.items.length) {
      await tx.insert(orders).values(
        data.orders.items.map((o) => ({
          tenantId: tenant.id,
          accountId: accountIds.get(o.accountRef)!,
          externalRef: o.ref,
          description: o.description,
          amountCents: o.amountCents,
          currency: o.currency,
          status: o.status,
          orderedAt: new Date(o.orderedAt),
        })),
      );
    }

    const incidentIds = new Map<string, string>();
    for (const i of data.incidents.items) {
      const [row] = await tx
        .insert(incidents)
        .values({
          tenantId: tenant.id,
          externalRef: i.ref,
          title: i.title,
          status: "resolved",
          severity: i.severity,
          summary: i.summary,
          alert: i.alert,
          logs: i.logs,
          startedAt: new Date(i.startedAt),
          resolvedAt: new Date(i.resolvedAt),
        })
        .returning({ id: incidents.id });
      incidentIds.set(i.ref, row.id);
    }

    let vectorIndex = 0;
    for (const { doc, chunks } of docs) {
      const [row] = await tx
        .insert(documents)
        .values({
          tenantId: tenant.id,
          kind: doc.kind,
          externalRef: doc.ref,
          title: doc.title,
          filename: `${doc.ref}.md`,
          mimeType: "text/markdown",
          sizeBytes: Buffer.byteLength(doc.body),
          contentHash: createHash("sha256").update(doc.body).digest("hex"),
          status: "ready",
          chunkCount: chunks.length,
        })
        .returning({ id: documents.id });
      await tx.insert(documentChunks).values(
        chunks.map((chunk) => ({
          tenantId: tenant.id,
          documentId: row.id,
          chunkIndex: chunk.index,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
          embedding: vectors[vectorIndex++],
        })),
      );
    }

    for (const t of data.tickets.items) {
      const createdAt = new Date(t.createdAt);
      const [row] = await tx
        .insert(tickets)
        .values({
          tenantId: tenant.id,
          externalRef: t.ref,
          subject: t.subject,
          customerName: t.customerName,
          customerEmail: t.customerEmail,
          customerAccountId: accountIds.get(t.accountRef) ?? null,
          incidentId: t.incidentRef ? (incidentIds.get(t.incidentRef) ?? null) : null,
          createdAt,
          updatedAt: createdAt,
        })
        .returning({ id: tickets.id });
      await tx.insert(ticketMessages).values([
        { tenantId: tenant.id, ticketId: row.id, authorType: "customer", body: t.body, createdAt },
        ...(t.followUp
          ? [
              {
                tenantId: tenant.id,
                ticketId: row.id,
                authorType: "customer" as const,
                body: t.followUp,
                createdAt: new Date(createdAt.getTime() + 3 * HOUR),
              },
            ]
          : []),
      ]);
    }

    return {
      tenant: tenant.slug,
      accounts: data.accounts.items.length,
      orders: data.orders.items.length,
      incidents: data.incidents.items.length,
      documents: docs.length,
      chunks: allChunks.length,
      tickets: data.tickets.items.length,
    };
  });
}
