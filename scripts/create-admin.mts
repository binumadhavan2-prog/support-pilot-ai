/**
 * Creates the first real administrator (self sign-up is disabled, so someone has to).
 *
 *   TENANT_SLUG=acme ADMIN_NAME="Ada Admin" ADMIN_EMAIL=ada@example.com ADMIN_PASSWORD='…'  *     npm run auth:create-admin
 *
 * The admin joins tenant TENANT_SLUG, which is created (named TENANT_NAME, default: the slug) if
 * it does not exist yet.
 * The password comes from the environment so it never appears in shell history arguments or logs.
 */
import { z } from "zod";
import { MIN_PASSWORD_LENGTH } from "@/server/auth/constants";
import { ensureTenant, tenantSlugSchema } from "@/server/tenants";
import { createScriptAuth } from "./lib/script-auth";

const input = z
  .object({
    TENANT_SLUG: tenantSlugSchema,
    TENANT_NAME: z.string().trim().min(1).optional(),
    ADMIN_NAME: z.string().trim().min(1, "ADMIN_NAME is required"),
    ADMIN_EMAIL: z.email("ADMIN_EMAIL must be a valid email"),
    ADMIN_PASSWORD: z
      .string({ error: "ADMIN_PASSWORD is required" })
      .min(
        MIN_PASSWORD_LENGTH,
        `ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`,
      ),
  })
  .safeParse(process.env);

if (!input.success) {
  console.error(z.prettifyError(input.error));
  process.exit(1);
}

const { auth, db, close } = createScriptAuth();
try {
  const tenant = await ensureTenant(db, {
    slug: input.data.TENANT_SLUG,
    name: input.data.TENANT_NAME ?? input.data.TENANT_SLUG,
  });
  const { user } = await auth.api.createUser({
    body: {
      name: input.data.ADMIN_NAME,
      email: input.data.ADMIN_EMAIL.toLowerCase(),
      password: input.data.ADMIN_PASSWORD,
      role: "admin",
      data: { tenantId: tenant.id },
    },
  });
  console.log(`Created admin ${user.email} (${user.id}) in tenant "${tenant.slug}".`);
} catch (error) {
  console.error("Could not create admin:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await close();
}
