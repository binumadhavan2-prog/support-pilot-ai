import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { documentKind, documentStatus } from "./enums";
import { sameTenantCascade, tenantId } from "./tenancy";

/**
 * Output size of `multilingual-e5-small`, the local embedding model (see
 * src/server/knowledge/embeddings.ts). Multilingual so Hinglish / Tanglish tickets still match
 * English articles. Changing the model or this number needs a migration and a re-embed.
 */
export const EMBEDDING_DIMENSIONS = 384;

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    kind: documentKind("kind").notNull().default("article"),
    // Id in the source system or dataset (e.g. the seed's "KB-012"). Unique per tenant.
    externalRef: text("external_ref"),
    title: text("title").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    // SHA-256 of the file contents; prevents ingesting the same file twice within a tenant.
    contentHash: text("content_hash").notNull(),
    status: documentStatus("status").notNull().default("processing"),
    errorMessage: text("error_message"),
    chunkCount: integer("chunk_count").notNull().default(0),
    uploadedById: text("uploaded_by_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("documents_tenant_status_idx").on(t.tenantId, t.status),
    unique("documents_tenant_hash_uq").on(t.tenantId, t.contentHash),
    unique("documents_tenant_ref_uq").on(t.tenantId, t.externalRef),
    unique("documents_id_tenant_uq").on(t.id, t.tenantId),
  ],
);

export const documentChunks = pgTable(
  "document_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    documentId: uuid("document_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    tokenCount: integer("token_count").notNull(),
    // Null until embedded; retrieval then falls back to full-text search for that chunk.
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    searchVector: tsvector("search_vector")
      .notNull()
      .generatedAlwaysAs(sql`to_tsvector('english', "content")`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("document_chunks_document_index_uq").on(t.documentId, t.chunkIndex),
    index("document_chunks_tenant_idx").on(t.tenantId),
    index("document_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("document_chunks_search_idx").using("gin", t.searchVector),
    unique("document_chunks_id_tenant_uq").on(t.id, t.tenantId),
    sameTenantCascade(
      "document_chunks_document_same_tenant_fk",
      [t.documentId, t.tenantId],
      [documents.id, documents.tenantId],
    ),
  ],
);
