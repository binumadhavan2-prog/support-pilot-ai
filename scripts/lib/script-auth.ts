import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { getEnv } from "@/env";
import { createAuth } from "@/server/auth/auth";

/** Auth instance for CLI scripts: own connection, no Next.js cookie bridge. Call `close()` when done. */
export function createScriptAuth() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // No .env.local: rely on the real environment.
  }
  const env = getEnv();
  const client = postgres(env.DATABASE_URL, { max: 1, prepare: false });
  const db = drizzle(client, { schema });
  const auth = createAuth({
    db,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    production: env.NODE_ENV === "production",
    withNextCookies: false,
  });
  return { auth, db, close: () => client.end() };
}
