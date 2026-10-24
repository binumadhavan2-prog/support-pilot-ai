import "server-only";
import { z } from "zod";
import { AppError, isAppError } from "@/lib/errors";
import { logger, type Logger } from "@/lib/logger";

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; requestId: string };
}

export interface HandlerContext<TParams> {
  requestId: string;
  log: Logger;
  params: TParams;
}

type RouteContext<TParams> = { params: Promise<TParams> };

// Accept a caller-supplied request ID only if it looks safe to echo back and log.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

export function resolveRequestId(headers: Headers): string {
  const incoming = headers.get("x-request-id");
  return incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
}

export function errorResponse(error: unknown, requestId: string, log: Logger): Response {
  let appError: AppError;
  if (isAppError(error)) {
    appError = error;
  } else if (error instanceof z.ZodError) {
    appError = new AppError("VALIDATION_ERROR", "Request validation failed", {
      details: z.flattenError(error),
    });
  } else {
    // Unknown errors: log everything server-side, expose nothing.
    log.error({ err: error }, "unhandled error");
    appError = new AppError("INTERNAL_ERROR", "An unexpected error occurred");
  }

  if (appError.status >= 500 && isAppError(error)) {
    log.error({ err: error, code: appError.code }, appError.message);
  } else if (appError.status < 500) {
    log.warn({ code: appError.code, status: appError.status }, appError.message);
  }

  const body: ApiErrorBody = {
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details !== undefined && { details: appError.details }),
      requestId,
    },
  };
  const headers: Record<string, string> = { "x-request-id": requestId };
  if (appError.retryAfterSeconds !== undefined) {
    headers["retry-after"] = String(appError.retryAfterSeconds);
  }
  return Response.json(body, { status: appError.status, headers });
}

/**
 * Wraps a route handler with request IDs, structured access logs and uniform error responses.
 * Auth/RBAC guards are composed inside handlers from Phase 2 onward.
 */
export function withApiHandler<TParams = Record<string, never>>(
  handler: (request: Request, ctx: HandlerContext<TParams>) => Promise<Response>,
) {
  return async (request: Request, routeContext?: RouteContext<TParams>): Promise<Response> => {
    const requestId = resolveRequestId(request.headers);
    const { pathname } = new URL(request.url);
    const log = logger.child({ requestId, method: request.method, path: pathname });
    const startedAt = performance.now();

    let response: Response;
    try {
      const params = (routeContext ? await routeContext.params : {}) as TParams;
      response = await handler(request, { requestId, log, params });
      response.headers.set("x-request-id", requestId);
    } catch (error) {
      response = errorResponse(error, requestId, log);
    }

    log.info(
      { status: response.status, durationMs: Math.round(performance.now() - startedAt) },
      "request completed",
    );
    return response;
  };
}

/** JSON request bodies larger than this are rejected before parsing. */
export const MAX_JSON_BYTES = 1024 * 1024;

/**
 * Parses and validates a JSON body: oversized bodies become a 413, malformed JSON a 400, and
 * neither a 500. Content-Length is only a fast path; the body actually read is measured too.
 */
export async function parseJsonBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  const tooLarge = () =>
    new AppError("PAYLOAD_TOO_LARGE", `Request body must be at most ${MAX_JSON_BYTES} bytes`);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_JSON_BYTES) throw tooLarge();
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw tooLarge();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON");
  }
  return schema.parse(raw);
}
