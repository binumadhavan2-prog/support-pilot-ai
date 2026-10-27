"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import type { ActionState } from "@/lib/action-state";
import { isAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { toActionError } from "@/server/action-error";
import { generateDraft, reviewDraft, reviewSchema } from "@/server/ai/drafts";
import { getDraftModel } from "@/server/ai/model";
import { requirePermission } from "@/server/auth/session";
import { runQueuedJobsAfterResponse } from "@/server/inline-jobs";
import { isEmailConfigured } from "@/server/email/mailer";
import { getEmbedder } from "@/server/knowledge/embedder";
import { TICKET_STATUSES, addAgentReply, addInternalNote, updateTicket } from "@/server/tickets";

/* Server actions are public endpoints: each one checks the caller's permission itself. */

export async function generateDraftAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const user = await requirePermission("draft:generate");
    const { ticketId } = z
      .object({ ticketId: z.string().min(1) })
      .parse(Object.fromEntries(formData));
    const model = getDraftModel();
    const result = await generateDraft(
      getDb(),
      { tenantId: user.tenantId, ticketId, userId: user.id },
      {
        embedQuery: getEmbedder()?.embedQuery ?? null,
        model,
        log: logger.child({ action: "generateDraft" }),
      },
    );
    revalidatePath(`/tickets/${ticketId}`);
    revalidatePath("/approvals");
    return {
      status: "success",
      message: result.grounded
        ? "Draft ready. Review it below."
        : "The help articles don't cover this ticket, so the draft is a holding reply. Edit it before approving.",
    };
  } catch (error) {
    if (isAppError(error) && error.code === "UPSTREAM_ERROR") {
      logger.warn({ err: error }, "draft generation failed upstream");
      return {
        status: "error",
        message: "The AI could not draft a reply right now. Please try again.",
      };
    }
    return toActionError(error, "generateDraft");
  }
}

export async function reviewDraftAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const user = await requirePermission("draft:review");
    const input = reviewSchema.parse(Object.fromEntries(formData));
    const result = await reviewDraft(
      getDb(),
      { tenantId: user.tenantId, reviewer: { id: user.id, name: user.name } },
      input,
      { emailEnabled: isEmailConfigured() },
    );
    runQueuedJobsAfterResponse(); // the reply email, when there is no worker
    revalidatePath(`/tickets/${result.ticketId}`);
    revalidatePath("/approvals");
    revalidatePath("/inbox");
    return {
      status: "success",
      message:
        result.status === "rejected"
          ? "Draft rejected."
          : `Reply approved and added to the conversation${emailNote(result.emailStatus)}`,
    };
  } catch (error) {
    return toActionError(error, "reviewDraft");
  }
}

const updateFormSchema = z.object({
  ticketId: z.string().min(1),
  status: z.enum(TICKET_STATUSES),
  // "" in the form means unassigned.
  assigneeId: z.string().transform((v) => (v === "" ? null : v)),
});

export async function updateTicketAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const user = await requirePermission("ticket:write");
    const { ticketId, status, assigneeId } = updateFormSchema.parse(Object.fromEntries(formData));
    const { changed } = await updateTicket(
      getDb(),
      { tenantId: user.tenantId, ticketId, actor: { type: "user", userId: user.id } },
      { status, assigneeId },
    );
    revalidatePath(`/tickets/${ticketId}`);
    revalidatePath("/inbox");
    return { status: "success", message: changed ? "Saved." : "No changes." };
  } catch (error) {
    return toActionError(error, "updateTicket");
  }
}

export async function replyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const user = await requirePermission("ticket:write");
    const { ticketId, body, kind } = z
      .object({
        ticketId: z.string().min(1),
        body: z.string(),
        // Enter submits the form without a button value: that means a customer reply.
        kind: z.enum(["reply", "note"]).default("reply"),
      })
      .parse(Object.fromEntries(formData));
    if (kind === "note") {
      await addInternalNote(
        getDb(),
        { tenantId: user.tenantId, ticketId, authorId: user.id },
        { body },
      );
      revalidatePath(`/tickets/${ticketId}`);
      return { status: "success", message: "Internal note added. The customer won't see it." };
    }
    const message = await addAgentReply(
      getDb(),
      { tenantId: user.tenantId, ticketId, authorId: user.id },
      { body },
      { emailEnabled: isEmailConfigured() },
    );
    runQueuedJobsAfterResponse(); // the reply email, when there is no worker
    revalidatePath(`/tickets/${ticketId}`);
    revalidatePath("/inbox");
    return {
      status: "success",
      message: `Reply added to the conversation${emailNote(message.emailStatus)}`,
    };
  } catch (error) {
    return toActionError(error, "reply");
  }
}

function emailNote(emailStatus: string | null) {
  return emailStatus === "queued" ? " and queued for email." : ".";
}
