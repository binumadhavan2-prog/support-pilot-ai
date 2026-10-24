import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema";

/**
 * Any Drizzle Postgres database with our schema: postgres-js in the app and scripts, PGlite in
 * tests. Services take this so they can be integration-tested on an in-memory database.
 */
export type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
