/**
 * Loads the DEMO DATA in seed/data into Postgres for tenant "acme". Safe to re-run: it replaces
 * the previously seeded rows and leaves anything created in the app alone.
 *
 *   npm run seed:load
 *   npm run seed:load -- --triage   # also queue triage jobs (run them with npm run jobs:work)
 *
 * Embeds every chunk with the local model (first run downloads it, ~130 MB).
 */
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { getEnv } from "@/env";
import { embed } from "@/server/knowledge/embeddings";
import { readAllDataFiles } from "./lib/files";
import { loadSeedData } from "./lib/load-data";

try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local: rely on the real environment.
}

const { values: args } = parseArgs({ options: { triage: { type: "boolean", default: false } } });
const data = readAllDataFiles(); // validates every file before touching the database
const client = postgres(getEnv().DATABASE_URL, { max: 1, prepare: false });
try {
  const started = Date.now();
  const counts = await loadSeedData(drizzle(client, { schema }), data, {
    embedPassages: (texts) => embed(texts, "passage"),
    log: (m) => console.log(m),
    queueTriage: args.triage,
  });
  console.log(`loaded in ${Math.round((Date.now() - started) / 1000)}s:`, counts);
} finally {
  await client.end();
}
