"use server";

import { headers } from "next/headers";
import { getDb } from "@/db/client";
import type { ActionState } from "@/lib/action-state";
import { toActionError } from "@/server/action-error";
import { sendEmailVerification } from "@/server/auth/account-email";
import { getAuth } from "@/server/auth/auth";
import { requireUser } from "@/server/auth/session";
import { isEmailConfigured } from "@/server/email/mailer";
import { isReservedAddress } from "@/server/email/outbound";

/* Server actions are public endpoints: this one checks the session itself. */

export async function sendVerificationAction(): Promise<ActionState> {
  try {
    const user = await requireUser();
    if (user.emailVerified)
      return { status: "success", message: "Your email is already confirmed." };
    if (!isEmailConfigured()) {
      return { status: "error", message: "Email isn't set up on this server yet." };
    }
    if (isReservedAddress(user.email)) {
      return { status: "error", message: "This is a demo or test address, so no email is sent." };
    }
    await sendEmailVerification(getAuth(), getDb(), {
      userId: user.id,
      email: user.email,
      headers: await headers(),
    });
    return {
      status: "success",
      message: `Sent. Check ${user.email} for the link (valid 24 hours).`,
    };
  } catch (error) {
    return toActionError(error, "sendVerification");
  }
}
