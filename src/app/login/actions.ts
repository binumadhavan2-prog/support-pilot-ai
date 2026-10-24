"use server";

import { isAPIError } from "better-auth/api";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getEnv } from "@/env";
import type { ActionState } from "@/lib/action-state";
import { logger } from "@/lib/logger";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { clientIp, recordAudit } from "@/server/audit";
import { getAuth } from "@/server/auth/auth";
import { DEMO_GUEST_EMAIL } from "@/server/auth/constants";

const signInSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(128),
  next: z.string().optional(),
});

// One message for every credential failure, so responses do not reveal which accounts exist.
const INVALID_CREDENTIALS = "Invalid email or password.";

export async function signInAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next") ?? undefined,
  });
  if (!parsed.success) return { status: "error", message: INVALID_CREDENTIALS };

  const { email, password, next } = parsed.data;
  const requestHeaders = await headers();

  try {
    const result = await getAuth().api.signInEmail({
      body: { email, password },
      headers: requestHeaders,
    });
    await recordAudit({
      tenantId: result.user.tenantId,
      actorId: result.user.id,
      action: "auth.signed_in",
      entityType: "user",
      entityId: result.user.id,
      ipAddress: clientIp(requestHeaders),
    });
  } catch (error) {
    if (isAPIError(error)) {
      // Log the reason server-side (never the password); keep the user-facing message generic.
      logger.warn({ status: error.statusCode, code: error.body?.code }, "sign-in rejected");
      if (error.statusCode === 429) {
        return { status: "error", message: "Too many attempts. Please wait a minute and retry." };
      }
      return { status: "error", message: INVALID_CREDENTIALS };
    }
    logger.error({ err: error }, "sign-in failed unexpectedly");
    return { status: "error", message: "Sign-in is temporarily unavailable. Please try again." };
  }

  // Outside the try: redirect() works by throwing.
  redirect(safeRedirectPath(next));
}

/** DEMO: signs in as the seeded read-only viewer. Disabled unless DEMO_USER_PASSWORD is set. */
export async function signInAsGuestAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const password = getEnv().DEMO_USER_PASSWORD;
  if (!password) return { status: "error", message: "Guest access is not enabled." };
  const next = formData.get("next");
  const requestHeaders = await headers();

  try {
    const result = await getAuth().api.signInEmail({
      body: { email: DEMO_GUEST_EMAIL, password },
      headers: requestHeaders,
    });
    await recordAudit({
      tenantId: result.user.tenantId,
      actorId: result.user.id,
      action: "auth.guest_signed_in",
      entityType: "user",
      entityId: result.user.id,
      ipAddress: clientIp(requestHeaders),
    });
  } catch (error) {
    if (isAPIError(error) && error.statusCode === 429) {
      return { status: "error", message: "Too many attempts. Please wait a minute and retry." };
    }
    // Most likely the demo accounts were never seeded (npm run db:seed:demo).
    logger.error({ err: error }, "guest sign-in failed");
    return { status: "error", message: "Guest access is unavailable right now." };
  }

  redirect(safeRedirectPath(typeof next === "string" ? next : undefined));
}
