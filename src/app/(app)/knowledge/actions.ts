"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import type { ActionState } from "@/lib/action-state";
import { isAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { toActionError } from "@/server/action-error";
import { askKnowledgeBase } from "@/server/ai/answer";
import { getAnswerModel } from "@/server/ai/model";
import { requirePermission } from "@/server/auth/session";
import {
  addDocument,
  deleteDocument,
  indexDocument,
  readUpload,
  uploadSchema,
} from "@/server/knowledge/documents";
import { getEmbedder } from "@/server/knowledge/embedder";
import type { AskState } from "./ask-state";

/* Server actions are public endpoints: each one checks the caller's permission itself. */

export async function uploadDocumentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requirePermission("document:manage");
    const file = formData.get("file");
    if (!(file instanceof File) || !file.name) {
      return { status: "error", message: "Choose a file to upload." };
    }
    const meta = uploadSchema.parse({
      kind: formData.get("kind"),
      title: (formData.get("title") as string | null) || undefined,
    });
    const upload = await readUpload(file);
    const doc = await addDocument(
      getDb(),
      {
        tenantId: actor.tenantId,
        uploadedById: actor.id,
        kind: meta.kind,
        title: meta.title,
        file: upload,
      },
      {
        embedPassages: getEmbedder()?.embedPassages ?? null,
        log: logger.child({ action: "uploadDocument" }),
      },
    );
    revalidatePath("/knowledge");
    return {
      status: "success",
      message: doc.semanticIndexed
        ? `Added "${doc.title}" (${doc.chunkCount} sections).`
        : `Added "${doc.title}" (${doc.chunkCount} sections) with keyword search only. ${doc.errorMessage}`,
    };
  } catch (error) {
    return toActionError(error, "uploadDocument");
  }
}

const documentIdSchema = z.object({ documentId: z.string().min(1) });

export async function reindexDocumentAction(formData: FormData): Promise<void> {
  const actor = await requirePermission("document:manage");
  const { documentId } = documentIdSchema.parse(Object.fromEntries(formData));
  await indexDocument(getDb(), actor.tenantId, documentId, {
    embedPassages: getEmbedder()?.embedPassages ?? null,
    log: logger.child({ action: "reindexDocument" }),
  });
  revalidatePath("/knowledge");
}

export async function deleteDocumentAction(formData: FormData): Promise<void> {
  const actor = await requirePermission("document:manage");
  const { documentId } = documentIdSchema.parse(Object.fromEntries(formData));
  await deleteDocument(getDb(), { tenantId: actor.tenantId, documentId, actorId: actor.id });
  revalidatePath("/knowledge");
}

const questionSchema = z
  .string()
  .trim()
  .min(3, "Ask a longer question.")
  .max(1000, "Keep the question under 1,000 characters.");

export async function askAction(_prev: AskState, formData: FormData): Promise<AskState> {
  const raw = formData.get("question");
  const parsed = questionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0].message,
      question: typeof raw === "string" ? raw : undefined,
    };
  }
  const question = parsed.data;
  try {
    const user = await requirePermission("kb:ask");
    const result = await askKnowledgeBase(
      getDb(),
      { tenantId: user.tenantId, userId: user.id, question },
      {
        embedQuery: getEmbedder()?.embedQuery ?? null,
        model: getAnswerModel(),
        log: logger.child({ action: "ask" }),
      },
    );
    return {
      status: "done",
      question,
      mode: result.mode,
      grounded: result.status === "answered",
      answer: result.answer,
      model: result.model,
      sources: result.sources.map(({ n, documentTitle, kind, content, score }) => ({
        n,
        documentTitle,
        kind,
        content,
        score,
      })),
    };
  } catch (error) {
    const message =
      isAppError(error) && error.status < 500
        ? error.message
        : isAppError(error) && error.code === "UPSTREAM_ERROR"
          ? "The AI could not answer right now. Please try again."
          : "Something went wrong. Please try again.";
    if (!isAppError(error) || error.status >= 500) logger.error({ err: error }, "ask failed");
    return { status: "error", message, question };
  }
}
