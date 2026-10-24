"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { logger } from "@/lib/logger";
import { getAuth } from "@/server/auth/auth";

export async function signOutAction() {
  try {
    await getAuth().api.signOut({ headers: await headers() });
  } catch (error) {
    // An already-invalid session is fine; the user ends up signed out either way.
    logger.warn({ err: error }, "sign-out failed");
  }
  redirect("/login");
}
