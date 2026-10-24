import { and, cosineDistance, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { documentChunks, documents } from "@/db/schema";
import type { AnyDatabase } from "@/db/types";
import type { Logger } from "@/lib/logger";

/** Embeds a search query. Injected so tests never load the real model. */
export type EmbedQuery = (text: string) => Promise<number[]>;

export interface SearchHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  kind: "article" | "runbook";
  content: string;
  /** Cosine similarity to the query (0-1), or null when the chunk matched by keyword only. */
  similarity: number | null;
  /** Combined rank score, normalized to 0-1 (1 = top of both lists). */
  score: number;
}

// Reciprocal rank fusion constant; 60 is the value from the original paper and works well.
const RRF_K = 60;
const CANDIDATES = 20;

/**
 * Hybrid search over the tenant's ready documents: semantic (pgvector cosine) and keyword
 * (Postgres full-text) candidates, merged with reciprocal rank fusion. Either half can be empty:
 * without embeddings (model unavailable) it is keyword search; without shared words
 * (Hinglish question, English article) it is semantic search.
 */
export async function searchKnowledge(
  db: AnyDatabase,
  tenantId: string,
  query: string,
  {
    embedQuery,
    limit = 6,
    kinds,
    log,
  }: {
    embedQuery: EmbedQuery | null;
    limit?: number;
    /** Restrict to document kinds, e.g. ["article"] for customer-facing text. Default: all. */
    kinds?: ("article" | "runbook")[];
    log?: Logger;
  },
): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];

  const base = and(
    eq(documentChunks.tenantId, tenantId),
    eq(documents.tenantId, tenantId),
    eq(documents.status, "ready"),
    kinds ? inArray(documents.kind, kinds) : undefined,
  );
  const columns = {
    chunkId: documentChunks.id,
    documentId: documents.id,
    documentTitle: documents.title,
    kind: documents.kind,
    content: documentChunks.content,
  };

  let semantic: (SearchRow & { similarity: number })[] = [];
  if (embedQuery) {
    try {
      const vector = await embedQuery(q);
      const distance = cosineDistance(documentChunks.embedding, vector);
      semantic = await db
        .select({ ...columns, similarity: sql<number>`1 - (${distance})` })
        .from(documentChunks)
        .innerJoin(documents, eq(documents.id, documentChunks.documentId))
        .where(and(base, isNotNull(documentChunks.embedding)))
        .orderBy(distance)
        .limit(CANDIDATES);
    } catch (error) {
      // Keyword results are still useful; don't fail the search because the model is unavailable.
      log?.warn({ err: error }, "semantic search unavailable, using keyword search only");
    }
  }

  // OR the query's words (stemmed, stop words removed): a question rarely shares every word with
  // the article that answers it. Each lexeme is quoted so punctuation cannot break the syntax.
  const tsquery = sql`to_tsquery('english', array_to_string(array(
    select quote_literal(l) from unnest(tsvector_to_array(to_tsvector('english', ${q}))) as l
  ), ' | '))`;
  const keyword = await db
    .select({
      ...columns,
      rank: sql<number>`ts_rank_cd(${documentChunks.searchVector}, ${tsquery})`,
    })
    .from(documentChunks)
    .innerJoin(documents, eq(documents.id, documentChunks.documentId))
    .where(and(base, sql`${documentChunks.searchVector} @@ ${tsquery}`))
    .orderBy(sql`ts_rank_cd(${documentChunks.searchVector}, ${tsquery}) desc`)
    .limit(CANDIDATES);

  const merged = new Map<string, SearchHit>();
  const add = (row: SearchRow, rank: number, similarity: number | null) => {
    const hit = merged.get(row.chunkId) ?? {
      chunkId: row.chunkId,
      documentId: row.documentId,
      documentTitle: row.documentTitle,
      kind: row.kind,
      content: row.content,
      similarity: null,
      score: 0,
    };
    hit.score += 1 / (RRF_K + rank);
    if (similarity !== null) hit.similarity = Number(similarity);
    merged.set(row.chunkId, hit);
  };
  semantic.forEach((row, i) => add(row, i + 1, row.similarity));
  keyword.forEach((row, i) => add(row, i + 1, null));

  const best = 2 / (RRF_K + 1);
  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((hit) => ({ ...hit, score: Math.min(1, hit.score / best) }));
}

interface SearchRow {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  kind: "article" | "runbook";
  content: string;
}
