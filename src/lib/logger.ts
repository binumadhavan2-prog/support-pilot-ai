import "server-only";
import pino from "pino";

const isDev = process.env.NODE_ENV === "development";
const isTest = process.env.NODE_ENV === "test";

/**
 * Structured JSON logger. Pipe through `pino-pretty` locally for readable output (`npm run dev:pretty`).
 * Known secret-bearing paths are redacted so an accidental `log.info({ headers })` cannot leak them.
 */
export const logger = pino({
  // Silent under Vitest unless LOG_LEVEL is set explicitly.
  level: process.env.LOG_LEVEL || (isTest ? "silent" : isDev ? "debug" : "info"),
  base: { service: "support-pilot-ai" },
  redact: {
    paths: [
      "password",
      "*.password",
      "token",
      "*.token",
      "apiKey",
      "*.apiKey",
      "headers.authorization",
      "headers.cookie",
      "*.headers.authorization",
      "*.headers.cookie",
      "DATABASE_URL",
      "ANTHROPIC_API_KEY",
      "BETTER_AUTH_SECRET",
    ],
    censor: "[redacted]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
