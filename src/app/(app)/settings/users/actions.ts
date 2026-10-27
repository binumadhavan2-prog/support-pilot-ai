"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import type { ActionState } from "@/lib/action-state";
import { toActionError } from "@/server/action-error";
import { clientIp, recordAudit } from "@/server/audit";
import { getDb } from "@/db/client";
import { getAuth } from "@/server/auth/auth";
import { sendEmailVerification } from "@/server/auth/account-email";
import { requirePermission } from "@/server/auth/session";
import { isEmailConfigured } from "@/server/email/mailer";
import { isReservedAddress } from "@/server/email/outbound";
import { logger } from "@/lib/logger";
import { assertUserInTenant } from "@/server/tenants";
import {
  assertNotSelfLockout,
  createUserSchema,
  setRoleSchema,
  userIdSchema,
} from "@/server/users";

/*
 * Each action re-checks the caller's permission itself: server actions are public HTTP endpoints,
 * reachable without the page that renders them. Better Auth's admin plugin then checks the role
 * again. The plugin knows nothing about tenants, so each action first confirms the target user is
 * in the actor's tenant, and new users are always created in the actor's tenant.
 */

export async function createUserAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requirePermission("user:manage");
    const input = createUserSchema.parse(Object.fromEntries(formData));
    const requestHeaders = await headers();

    const { user } = await getAuth().api.createUser({
      body: {
        name: input.name,
        email: input.email,
        password: input.password,
        role: input.role,
        data: { tenantId: actor.tenantId },
      },
      headers: requestHeaders,
    });
    await recordAudit({
      tenantId: actor.tenantId,
      actorId: actor.id,
      action: "user.created",
      entityType: "user",
      entityId: user.id,
      metadata: { role: input.role },
      ipAddress: clientIp(requestHeaders),
    });
    // Ask the new user to confirm their address. A failure here must not undo the account.
    let verification = "";
    if (isEmailConfigured() && !isReservedAddress(user.email)) {
      try {
        await sendEmailVerification(getAuth(), getDb(), {
          userId: user.id,
          email: user.email,
          headers: requestHeaders,
        });
        verification = " A verification email is on its way.";
      } catch (error) {
        logger.warn({ err: error, userId: user.id }, "verification email not sent");
      }
    }
    revalidatePath("/settings/users");
    return {
      status: "success",
      message: `Created ${input.email} as ${input.role}.${verification}`,
    };
  } catch (error) {
    return toActionError(error, "createUser");
  }
}

export async function setRoleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const actor = await requirePermission("user:manage");
    const { userId, role } = setRoleSchema.parse(Object.fromEntries(formData));
    assertNotSelfLockout(actor, userId, { kind: "set-role", role });
    await assertUserInTenant(getDb(), actor.tenantId, userId);
    const requestHeaders = await headers();

    await getAuth().api.setRole({ body: { userId, role }, headers: requestHeaders });
    await recordAudit({
      tenantId: actor.tenantId,
      actorId: actor.id,
      action: "user.role_changed",
      entityType: "user",
      entityId: userId,
      metadata: { role },
      ipAddress: clientIp(requestHeaders),
    });
    revalidatePath("/settings/users");
    return { status: "success", message: `Role updated to ${role}.` };
  } catch (error) {
    return toActionError(error, "setRole");
  }
}

export async function setBannedAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requirePermission("user:manage");
    const { userId } = userIdSchema.parse(Object.fromEntries(formData));
    const ban = formData.get("intent") === "ban";
    if (ban) assertNotSelfLockout(actor, userId, { kind: "ban" });
    await assertUserInTenant(getDb(), actor.tenantId, userId);
    const requestHeaders = await headers();

    // Banning also revokes the user's sessions, so access ends immediately.
    if (ban) {
      await getAuth().api.banUser({ body: { userId }, headers: requestHeaders });
    } else {
      await getAuth().api.unbanUser({ body: { userId }, headers: requestHeaders });
    }
    await recordAudit({
      tenantId: actor.tenantId,
      actorId: actor.id,
      action: ban ? "user.banned" : "user.unbanned",
      entityType: "user",
      entityId: userId,
      ipAddress: clientIp(requestHeaders),
    });
    revalidatePath("/settings/users");
    return { status: "success", message: ban ? "User banned." : "User unbanned." };
  } catch (error) {
    return toActionError(error, "setBanned");
  }
}
