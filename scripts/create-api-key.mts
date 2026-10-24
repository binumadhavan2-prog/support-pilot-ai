/**
 * Creates an API key for a tenant's integrations (webhooks, inbound email, curl).
 *
 *   TENANT_SLUG=acme KEY_NAME="Helpdesk webhook" npm run api-key:create
 *
 * The key is printed once and only its hash is stored. Send it as `Authorization: Bearer <key>`.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { tenants } from "@/db/schema";
import { apiKeyNameSchema, createApiKey } from "@/server/api-keys";
import { tenantSlugSchema } from "@/server/tenants";
import { createScriptAuth } from "./lib/script-auth";

const input = z
  .object({ TENANT_SLUG: tenantSlugSchema, KEY_NAME: apiKeyNameSchema })
  .safeParse(process.env);

if (!input.success) {
  console.error(z.prettifyError(input.error));
  process.exit(1);
}

const { db, close } = createScriptAuth();
try {
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, input.data.TENANT_SLUG));
  if (!tenant) {
    console.error(
      `No tenant "${input.data.TENANT_SLUG}". Create it first (e.g. npm run seed:load).`,
    );
    process.exitCode = 1;
  } else {
    const { key, prefix } = await createApiKey(db, {
      tenantId: tenant.id,
      name: input.data.KEY_NAME,
    });
    console.log(
      `Created API key "${input.data.KEY_NAME}" (${prefix}…) for "${input.data.TENANT_SLUG}".`,
    );
    console.log("Copy it now; it cannot be shown again:\n");
    console.log(key);
  }
} finally {
  await close();
}
