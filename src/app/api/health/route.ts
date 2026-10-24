import { sql } from "drizzle-orm";
import { connection } from "next/server";
import { getDb } from "@/db/client";
import { withApiHandler } from "@/lib/api/handler";

/**
 * Liveness + database readiness probe for Docker/hosting health checks.
 * Reports only up/down: no versions, hostnames or error text, so it is safe to expose publicly.
 */
export const GET = withApiHandler(async (_request, { log }) => {
  await connection();

  let database: "up" | "down" = "up";
  try {
    await getDb().execute(sql`select 1`);
  } catch (error) {
    database = "down";
    log.error({ err: error }, "health check: database unreachable");
  }

  const healthy = database === "up";
  return Response.json(
    { status: healthy ? "ok" : "degraded", checks: { database } },
    { status: healthy ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
});
