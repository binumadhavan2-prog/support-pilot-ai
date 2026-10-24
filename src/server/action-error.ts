import "server-only";
import { isAPIError } from "better-auth/api";
import { z } from "zod";
import type { ActionState } from "@/lib/action-state";
import { isAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/** Maps thrown errors to a safe form state. Unexpected errors are logged and never echoed. */
export function toActionError(error: unknown, context: string): ActionState {
  if (error instanceof z.ZodError) {
    return {
      status: "error",
      message: "Please fix the highlighted fields.",
      fieldErrors: z.flattenError(error).fieldErrors as ActionState["fieldErrors"],
    };
  }
  if (isAppError(error) && error.status < 500) {
    return { status: "error", message: error.message };
  }
  // Better Auth client errors (e.g. "User already exists") carry user-safe messages.
  if (isAPIError(error) && error.statusCode < 500 && error.message) {
    logger.warn({ context, status: error.statusCode }, error.message);
    return { status: "error", message: error.message };
  }
  logger.error({ err: error, context }, "server action failed");
  return { status: "error", message: "Something went wrong. Please try again." };
}
