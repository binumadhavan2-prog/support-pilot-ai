/**
 * DEMO DATA. Creates one demo account per role in the demo tenant ("acme") so reviewers can try
 * the RBAC model.
 * Accounts are clearly labeled ("[Demo] …", @demo.supportpilot.test) and share one password
 * supplied via DEMO_USER_PASSWORD. Never run this against a database holding real users unless
 * you intend to expose these accounts. Safe to re-run: existing demo accounts are skipped.
 *
 *   DEMO_USER_PASSWORD='…' npm run db:seed:demo
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { user } from "@/db/schema";
import { DEMO_GUEST_EMAIL, MIN_PASSWORD_LENGTH } from "@/server/auth/constants";
import type { Role } from "@/server/auth/permissions";
import { ensureTenant } from "@/server/tenants";
import { createScriptAuth } from "./lib/script-auth";
import { DEMO_TENANT } from "../seed/lib/demo-tenant";

const DEMO_USERS: { name: string; email: string; role: Role }[] = [
  { name: "[Demo] Avery Admin", email: "admin@demo.supportpilot.test", role: "admin" },
  { name: "[Demo] Sam Agent", email: "agent@demo.supportpilot.test", role: "agent" },
  { name: "[Demo] Riley Viewer", email: DEMO_GUEST_EMAIL, role: "viewer" },
];

const password = z
  .string({ error: "DEMO_USER_PASSWORD is required" })
  .min(MIN_PASSWORD_LENGTH, `DEMO_USER_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .safeParse(process.env.DEMO_USER_PASSWORD);

if (!password.success) {
  console.error(z.prettifyError(password.error));
  process.exit(1);
}

const { auth, db, close } = createScriptAuth();
try {
  const tenant = await ensureTenant(db, DEMO_TENANT);
  for (const demo of DEMO_USERS) {
    const [existing] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, demo.email));
    if (existing) {
      console.log(`skip    ${demo.email} (exists)`);
      continue;
    }
    await auth.api.createUser({
      body: { ...demo, password: password.data, data: { tenantId: tenant.id } },
    });
    console.log(`created ${demo.email} as ${demo.role}`);
  }
} finally {
  await close();
}
