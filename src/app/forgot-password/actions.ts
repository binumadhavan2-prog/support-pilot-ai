"use server";

import { headers } from "next/headers";
import { getDb } from "@/db/client";
import type { ActionState } from "@/lib/action-state";
import { toActionError } from "@/server/action-error";
import { clientIp } from "@/server/audit";
import { forgotPasswordSchema, requestPasswordReset } from "@/server/auth/account-email";
import { getAuth } from "@/server/auth/auth";

/* Public (signed-out) action: input is validated and rate limited in requestPasswordReset. */

export async function forgotPasswordAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const requestHeaders = await headers();
    const { email } = forgotPasswordSchema.parse(Object.fromEntries(formData));
    const { message } = await requestPasswordReset(getAuth(), getDb(), {
      email,
      ip: clientIp(requestHeaders),
      headers: requestHeaders,
    });
    return { status: "success", message };
  } catch (error) {
    return toActionError(error, "forgotPassword");
  }
}
