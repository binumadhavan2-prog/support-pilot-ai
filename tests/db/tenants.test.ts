import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user } from "@/db/schema";
import { isAppError } from "@/lib/errors";
import { assertUserInTenant, ensureTenant, listTenantUsers } from "@/server/tenants";
import { createTestDb, type TestDb } from "./test-db";

let db: TestDb;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close?.();
});

describe("ensureTenant", () => {
  it("creates a tenant once and returns the same row afterwards", async () => {
    const first = await ensureTenant(db, { slug: "acme", name: "Acme Cloud" });
    const again = await ensureTenant(db, { slug: "acme", name: "Ignored on re-run" });
    expect(again.id).toBe(first.id);
    expect(again.name).toBe("Acme Cloud");
  });

  it("rejects invalid slugs before touching the database", async () => {
    await expect(ensureTenant(db, { slug: "Not OK", name: "x" })).rejects.toThrow();
  });
});

describe("tenant-scoped user lookups", () => {
  let acme: string;
  let globex: string;

  beforeAll(async () => {
    acme = (await ensureTenant(db, { slug: "acme-users", name: "Acme" })).id;
    globex = (await ensureTenant(db, { slug: "globex", name: "Globex" })).id;
    await db.insert(user).values([
      { id: "u-acme", tenantId: acme, name: "A", email: "a@acme.test" },
      { id: "u-globex", tenantId: globex, name: "G", email: "g@globex.test" },
    ]);
  });

  it("lists only the tenant's own users", async () => {
    expect((await listTenantUsers(db, acme)).map((u) => u.id)).toEqual(["u-acme"]);
    expect((await listTenantUsers(db, globex)).map((u) => u.id)).toEqual(["u-globex"]);
  });

  it("accepts a user in the same tenant", async () => {
    await expect(assertUserInTenant(db, acme, "u-acme")).resolves.toBeUndefined();
  });

  it("answers NOT_FOUND for another tenant's user, exactly as for a missing one", async () => {
    const errorFor = (userId: string) =>
      assertUserInTenant(db, acme, userId).then(
        () => null,
        (error: unknown) => error,
      );
    const crossTenant = await errorFor("u-globex");
    const missing = await errorFor("does-not-exist");

    expect(isAppError(crossTenant) && crossTenant.code).toBe("NOT_FOUND");
    expect(isAppError(missing) && missing.code).toBe("NOT_FOUND");
    expect((crossTenant as Error).message).toBe((missing as Error).message);
  });
});
