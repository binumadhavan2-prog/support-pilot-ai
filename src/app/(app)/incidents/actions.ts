"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import type { ActionState } from "@/lib/action-state";
import { toActionError } from "@/server/action-error";
import { requirePermission } from "@/server/auth/session";
import {
  createIncident,
  createIncidentSchema,
  linkTicket,
  unlinkTicket,
  updateIncident,
  updateIncidentSchema,
} from "@/server/incidents";

/* Server actions are public endpoints: each one checks the caller's permission itself. */

const incidentIdSchema = z.object({ incidentId: z.string().min(1) });

function revalidateIncident(incidentId: string) {
  revalidatePath("/incidents");
  revalidatePath(`/incidents/${incidentId}`);
}

export async function createIncidentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let id: string;
  try {
    const user = await requirePermission("incident:manage");
    const input = createIncidentSchema.parse(Object.fromEntries(formData));
    ({ id } = await createIncident(getDb(), { tenantId: user.tenantId, actorId: user.id }, input));
    revalidatePath("/incidents");
  } catch (error) {
    return toActionError(error, "createIncident");
  }
  // Outside the try: redirect() works by throwing.
  redirect(`/incidents/${id}`);
}

export async function updateIncidentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const user = await requirePermission("incident:manage");
    const form = Object.fromEntries(formData);
    const { incidentId } = incidentIdSchema.parse(form);
    const { changed } = await updateIncident(
      getDb(),
      { tenantId: user.tenantId, actorId: user.id, incidentId },
      updateIncidentSchema.parse(form),
    );
    revalidateIncident(incidentId);
    return { status: "success", message: changed ? "Saved." : "No changes." };
  } catch (error) {
    return toActionError(error, "updateIncident");
  }
}

export async function linkTicketAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const user = await requirePermission("incident:manage");
    const form = Object.fromEntries(formData);
    const { incidentId } = incidentIdSchema.parse(form);
    const { ticketId, changed } = await linkTicket(
      getDb(),
      { tenantId: user.tenantId, actorId: user.id, incidentId },
      { ticketNumber: String(form.ticketNumber ?? "").replace(/^#/, "") },
    );
    revalidateIncident(incidentId);
    revalidatePath(`/tickets/${ticketId}`);
    return {
      status: "success",
      message: changed ? "Ticket linked." : "That ticket is already linked.",
    };
  } catch (error) {
    return toActionError(error, "linkTicket");
  }
}

export async function unlinkTicketAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const user = await requirePermission("incident:manage");
    const { incidentId, ticketId } = incidentIdSchema
      .extend({ ticketId: z.string().min(1) })
      .parse(Object.fromEntries(formData));
    await unlinkTicket(
      getDb(),
      { tenantId: user.tenantId, actorId: user.id, incidentId },
      { ticketId },
    );
    revalidateIncident(incidentId);
    revalidatePath(`/tickets/${ticketId}`);
    return { status: "success", message: "Ticket unlinked." };
  } catch (error) {
    return toActionError(error, "unlinkTicket");
  }
}
