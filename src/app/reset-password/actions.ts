"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { toActionError } from "@/server/action-error";
import { resetPassword, resetPasswordSchema } from "@/server/auth/account-email";
import { getAuth } from "@/server/auth/auth";

/* Public (signed-out) action: the single-use token is the authorization, checked by Better Auth. */

export async function resetPasswordAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const requestHeaders = await headers();
    const { token, password } = resetPasswordSchema.parse(Object.fromEntries(formData));
    await resetPassword(getAuth(), { token, password, headers: requestHeaders });
  } catch (error) {
    return toActionError(error, "resetPassword");
  }
  // Outside the try: redirect() works by throwing.
  redirect("/login?reset=1");
}
