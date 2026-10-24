import "server-only";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getEnv } from "@/env";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

// Reuse one pool across hot reloads in development.
const globalForDb = globalThis as unknown as { __db?: Database };

/** Lazily creates the connection pool so builds and tests do not need a database. */
export function getDb(): Database {
  if (!globalForDb.__db) {
    const env = getEnv();
    const client = postgres(env.DATABASE_URL, {
      max: env.DATABASE_POOL_MAX,
      // Required for transaction-mode poolers (Supabase pooler on port 6543, PgBouncer).
      prepare: false,
    });
    globalForDb.__db = drizzle(client, { schema });
  }
  return globalForDb.__db;
}
