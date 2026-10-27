import "server-only";
import { createHash } from "node:crypto";
import { isAPIError } from "better-auth/api";
import { z } from "zod";
import type { AnyDatabase } from "@/db/types";
import { AppError, isAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { consumeRateLimit } from "../rate-limit";
import type { Auth } from "./auth";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./constants";

/*
 * Password reset and email verification, called from the public forgot / reset password pages and
 * from Settings. Better Auth does the token work; these add input validation, rate limits (server
 * actions bypass Better Auth's HTTP limiter) and responses that never reveal whether an account
 * exists.
 */

export const RESET_REQUESTED_MESSAGE =
  "If an account exists for that email, we've sent a link to reset the password. It expires in 1 hour.";

const RESET_WINDOW_SECONDS = 15 * 60;

export const forgotPasswordSchema = z.object({ email: z.email("Enter your email").max(254) });

export const resetPasswordSchema = z
  .object({
    token: z.string().min(1).max(512),
    password: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`)
      .max(MAX_PASSWORD_LENGTH),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    path: ["confirm"],
    message: "The passwords don't match",
  });

const hashed = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

async function limit(db: AnyDatabase, key: string, max: number, windowSeconds: number) {
  try {
    await consumeRateLimit(db, key, max, { windowSeconds });
  } catch (error) {
    if (isAppError(error) && error.code === "RATE_LIMITED") {
      throw new AppError("RATE_LIMITED", "Too many requests. Please wait a few minutes and retry.");
    }
    throw error;
  }
}

/**
 * Sends a reset link if the account exists. Same result either way; limited per IP and per email
 * (the email is stored hashed in the counter key, never in clear).
 */
export async function requestPasswordReset(
  auth: Auth,
  db: AnyDatabase,
  { email, ip, headers }: { email: string; ip: string | null; headers?: Headers },
) {
  await limit(db, `password-reset:ip:${ip ?? "unknown"}`, 10, RESET_WINDOW_SECONDS);
  await limit(db, `password-reset:email:${hashed(email.toLowerCase())}`, 3, RESET_WINDOW_SECONDS);
  try {
    await auth.api.requestPasswordReset({
      body: { email, redirectTo: "/reset-password" },
      headers,
    });
  } catch (error) {
    // Logged, not shown: any difference in the response would reveal the account exists.
    logger.error({ err: error }, "password reset request failed");
  }
  return { message: RESET_REQUESTED_MESSAGE };
}

/** Sets the new password from a reset link. Better Auth signs out every session of the user. */
export async function resetPassword(
  auth: Auth,
  { token, password, headers }: { token: string; password: string; headers?: Headers },
) {
  try {
    await auth.api.resetPassword({ body: { token, newPassword: password }, headers });
  } catch (error) {
    if (isAPIError(error) && error.statusCode < 500) {
      throw new AppError(
        "VALIDATION_ERROR",
        "This reset link is invalid or has expired. Request a new one.",
      );
    }
    throw error;
  }
}

/** Emails the signed-in user a link to confirm their address (limited to 3 an hour). */
export async function sendEmailVerification(
  auth: Auth,
  db: AnyDatabase,
  { userId, email, headers }: { userId: string; email: string; headers?: Headers },
) {
  await limit(db, `email-verification:user:${userId}`, 3, 60 * 60);
  await auth.api.sendVerificationEmail({
    body: { email, callbackURL: "/settings?verified=1" },
    headers,
  });
}
