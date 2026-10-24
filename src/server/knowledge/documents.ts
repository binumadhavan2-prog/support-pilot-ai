import { createHash } from "node:crypto";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { documentChunks, documents } from "@/db/schema";
import { documentKind } from "@/db/schema/enums";
import type { AnyDatabase } from "@/db/types";
import { AppError } from "@/lib/errors";
import type { Logger } from "@/lib/logger";
import { recordAudit } from "../audit";
import { chunkMarkdown } from "./chunk";

/** Under Next's 1 MB server-action body limit, with room for the rest of the form. */
export const MAX_DOCUMENT_BYTES = 900 * 1024;

/** Plain text formats only for now; PDF and DOCX need a parser and are not supported yet. */
export const ACCEPTED_EXTENSIONS = [".md", ".markdown", ".txt"] as const;
const MIME_BY_EXTENSION: Record<(typeof ACCEPTED_EXTENSIONS)[number], string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
};

export const DOCUMENT_KINDS = documentKind.enumValues;

/** Embeds stored chunks. Injected so tests never load the real model. */
export type EmbedPassages = (texts: string[]) => Promise<number[][]>;

export const uploadSchema = z.object({
  kind: z.enum(DOCUMENT_KINDS),
  title: z.string().trim().max(200).optional(),
});

function extensionOf(filename: string) {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

/** Uses the first "# Heading" as the title, else the file name without its extension. */
export function documentTitle(filename: string, text: string) {
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(text)?.[1];
  const base = filename
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return (heading || base || "Untitled").slice(0, 200);
}

/** Validates an uploaded file and decodes it as UTF-8 text. */
export async function readUpload(file: { name: string; size: number; text(): Promise<string> }) {
  const extension = extensionOf(file.name);
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Only ${ACCEPTED_EXTENSIONS.join(", ")} files are supported for now`,
    );
  }
  if (file.size === 0) throw new AppError("VALIDATION_ERROR", "The file is empty");
  if (file.size > MAX_DOCUMENT_BYTES) {
    throw new AppError("VALIDATION_ERROR", "The file is larger than 900 KB");
  }
  const text = (await file.text()).replace(/^\uFEFF/, "");
  // A text file full of NUL or replacement characters is almost certainly binary.
  if (text.includes("\u0000") || (text.match(/\uFFFD/g)?.length ?? 0) > 20) {
    throw new AppError("VALIDATION_ERROR", "The file does not look like UTF-8 text");
  }
  if (!text.trim()) throw new AppError("VALIDATION_ERROR", "The file has no text");
  return {
    filename: file.name.slice(0, 255),
    mimeType: MIME_BY_EXTENSION[extension as keyof typeof MIME_BY_EXTENSION],
    sizeBytes: file.size,
    text,
  };
}

/**
 * Stores a document and its chunks, then indexes them for semantic search. Chunks are searchable
 * by keyword as soon as they are stored; if embedding fails (model download, memory), the
 * document stays usable with keyword search and records why, so an admin can re-index it.
 */
export async function addDocument(
  db: AnyDatabase,
  input: {
    tenantId: string;
    uploadedById: string | null;
    kind: (typeof DOCUMENT_KINDS)[number];
    title?: string;
    file: { filename: string; mimeType: string; sizeBytes: number; text: string };
  },
  { embedPassages, log }: { embedPassages: EmbedPassages | null; log: Logger },
) {
  const { tenantId, file } = input;
  const title = input.title || documentTitle(file.filename, file.text);
  const chunks = chunkMarkdown(title, file.text);
  if (chunks.length === 0) throw new AppError("VALIDATION_ERROR", "The file has no text");
  const contentHash = createHash("sha256").update(file.text).digest("hex");

  const [existing] = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), eq(documents.contentHash, contentHash)));
  if (existing) {
    throw new AppError(
      "CONFLICT",
      `This file is already in the knowledge base ("${existing.title}")`,
    );
  }

  const doc = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(documents)
      .values({
        tenantId,
        kind: input.kind,
        title,
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        contentHash,
        status: "ready",
        chunkCount: chunks.length,
        uploadedById: input.uploadedById,
      })
      .returning();
    await tx.insert(documentChunks).values(
      chunks.map((c) => ({
        tenantId,
        documentId: row.id,
        chunkIndex: c.index,
        content: c.content,
        tokenCount: c.tokenCount,
      })),
    );
    await recordAudit(
      {
        tenantId,
        actorId: input.uploadedById,
        action: "document.uploaded",
        entityType: "document",
        entityId: row.id,
        metadata: { title, kind: input.kind, chunks: chunks.length, sizeBytes: file.sizeBytes },
      },
      tx,
    );
    return row;
  });

  const indexed = await indexDocument(db, tenantId, doc.id, { embedPassages, log });
  return { ...doc, ...indexed };
}

/**
 * Embeds the document's chunks that have no embedding yet. Never throws for an embedding
 * failure: it is recorded on the document instead, and keyword search keeps working.
 */
export async function indexDocument(
  db: AnyDatabase,
  tenantId: string,
  documentId: string,
  { embedPassages, log }: { embedPassages: EmbedPassages | null; log: Logger },
) {
  const pending = await db
    .select({ id: documentChunks.id, content: documentChunks.content })
    .from(documentChunks)
    .where(
      and(
        eq(documentChunks.documentId, documentId),
        eq(documentChunks.tenantId, tenantId),
        isNull(documentChunks.embedding),
      ),
    )
    .orderBy(asc(documentChunks.chunkIndex));

  let errorMessage: string | null = null;
  try {
    if (pending.length > 0 && !embedPassages) {
      errorMessage = "Semantic search is turned off (SEMANTIC_SEARCH=off); keyword search only.";
    } else if (pending.length > 0 && embedPassages) {
      const vectors = await embedPassages(pending.map((c) => c.content));
      if (vectors.length !== pending.length) throw new Error("Embedder returned the wrong count");
      await db.transaction(async (tx) => {
        for (let i = 0; i < pending.length; i++) {
          await tx
            .update(documentChunks)
            .set({ embedding: vectors[i] })
            .where(eq(documentChunks.id, pending[i].id));
        }
      });
    }
  } catch (error) {
    log.error({ err: error, documentId }, "document embedding failed");
    errorMessage = "Semantic index unavailable; keyword search still works. Try re-indexing.";
  }
  await db
    .update(documents)
    .set({ errorMessage })
    .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)));
  return { semanticIndexed: errorMessage === null, errorMessage };
}

export async function listDocuments(db: AnyDatabase, tenantId: string) {
  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      kind: documents.kind,
      filename: documents.filename,
      sizeBytes: documents.sizeBytes,
      status: documents.status,
      errorMessage: documents.errorMessage,
      chunkCount: documents.chunkCount,
      externalRef: documents.externalRef,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(eq(documents.tenantId, tenantId))
    .orderBy(desc(documents.createdAt));
  return rows.map(({ externalRef, ...row }) => ({ ...row, isDemo: externalRef !== null }));
}

export async function deleteDocument(
  db: AnyDatabase,
  { tenantId, documentId, actorId }: { tenantId: string; documentId: string; actorId: string },
) {
  if (!z.uuid().safeParse(documentId).success)
    throw new AppError("NOT_FOUND", "Document not found");
  await db.transaction(async (tx) => {
    // Chunks cascade; citations keep their quote and title, with the chunk link cleared.
    const [row] = await tx
      .delete(documents)
      .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)))
      .returning({ id: documents.id, title: documents.title });
    if (!row) throw new AppError("NOT_FOUND", "Document not found");
    await recordAudit(
      {
        tenantId,
        actorId,
        action: "document.deleted",
        entityType: "document",
        entityId: row.id,
        metadata: { title: row.title },
      },
      tx,
    );
  });
}
