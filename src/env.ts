import "server-only";
import path from "node:path";
import { z } from "zod";

/** Treats empty strings (e.g. `FOO=` in .env files) as unset. */
const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["debug", "info", "warn", "error"]).optional(),
  ),
  DATABASE_URL: z
    .string({ error: "DATABASE_URL is required" })
    .refine((value) => /^postgres(ql)?:\/\//.test(value), {
      message: "DATABASE_URL must be a postgres:// or postgresql:// connection string",
    }),
  // Connections in the app's pool. 1 for single-session dev databases (the local PGlite server).
  DATABASE_POOL_MAX: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(1).max(100).default(10),
  ),
  BETTER_AUTH_SECRET: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string({ error: "BETTER_AUTH_SECRET is required" })
      .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  ),
  // Required in production (enforced below); defaults to localhost in development.
  BETTER_AUTH_URL: z.preprocess((value) => (value === "" ? undefined : value), z.url().optional()),
  // Optional until the phase that uses them; each feature checks for its key at call time.
  ANTHROPIC_API_KEY: optionalString,
  // Model for ticket triage. Defaults to the current Opus; a cheaper model can be set here and
  // compared with `npm run eval:triage`.
  TRIAGE_MODEL: optionalString,
  // Model for knowledge-base answers and draft replies (default: the current Opus).
  ANSWER_MODEL: optionalString,
  // "off" skips the local embedding model (saves ~300 MB of memory): search is keyword-only.
  SEMANTIC_SEARCH: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["on", "off"]).default("on"),
  ),
  // Where the embedding model is downloaded (default: <app>/.cache/transformers). Serverless hosts
  // such as Vercel only allow writes under /tmp.
  MODEL_CACHE_DIR: optionalString.refine((value) => value === undefined || path.isAbsolute(value), {
    message: "MODEL_CACHE_DIR must be an absolute path",
  }),
  // Password of the seeded demo accounts. When set, the login page offers "Try as Guest", which
  // signs in as the read-only demo viewer. Leave unset on any deployment with real users.
  DEMO_USER_PASSWORD: optionalString,
});

const refinedEnvSchema = envSchema
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && !env.BETTER_AUTH_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["BETTER_AUTH_URL"],
        message: "BETTER_AUTH_URL is required in production (the app's public base URL)",
      });
    }
  })
  .transform((env) => ({
    ...env,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL ?? "http://localhost:3000",
  }));

export type Env = z.output<typeof refinedEnvSchema>;

export class EnvValidationError extends Error {
  constructor(details: string) {
    super(`Invalid environment configuration:\n${details}`);
    this.name = "EnvValidationError";
  }
}

/** Pure parser, exported for tests. Error messages name the variable, never its value. */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = refinedEnvSchema.safeParse(raw);
  if (!result.success) {
    throw new EnvValidationError(z.prettifyError(result.error));
  }
  return result.data;
}

let cached: Env | undefined;

/**
 * Validated server environment. Read lazily so `next build` does not need runtime secrets;
 * `instrumentation.ts` calls this at server start so a bad config fails fast.
 */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
