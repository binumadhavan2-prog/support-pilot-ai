/**
 * Typed application errors. Services throw these; the API layer maps them to HTTP responses.
 * Anything that is not an AppError is treated as an unexpected 500 and its message is never sent
 * to the client.
 */
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

const statusByCode: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Safe-to-expose structured details (e.g. field errors). Never put secrets or stack traces here. */
  readonly details?: unknown;
  /** Sent as `Retry-After` (seconds) on rate-limit responses. */
  readonly retryAfterSeconds?: number;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { details?: unknown; cause?: unknown; retryAfterSeconds?: number },
  ) {
    super(message, { cause: options?.cause });
    this.name = "AppError";
    this.code = code;
    this.status = statusByCode[code];
    this.details = options?.details;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

export const notFound = (entity: string) => new AppError("NOT_FOUND", `${entity} not found`);
export const forbidden = (message = "You do not have permission to perform this action") =>
  new AppError("FORBIDDEN", message);
export const unauthenticated = () => new AppError("UNAUTHENTICATED", "Authentication required");

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
