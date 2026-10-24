import { describe, expect, it } from "vitest";
import { assertNotSelfLockout, createUserSchema } from "./users";

const actor = { id: "admin-1" };

describe("assertNotSelfLockout", () => {
  it("blocks an admin from demoting themselves", () => {
    expect(() =>
      assertNotSelfLockout(actor, "admin-1", { kind: "set-role", role: "viewer" }),
    ).toThrow(/own admin role/);
  });

  it("blocks an admin from banning themselves", () => {
    expect(() => assertNotSelfLockout(actor, "admin-1", { kind: "ban" })).toThrow(/ban your own/);
  });

  it("allows re-saving their own admin role", () => {
    expect(() =>
      assertNotSelfLockout(actor, "admin-1", { kind: "set-role", role: "admin" }),
    ).not.toThrow();
  });

  it("allows changes to other users", () => {
    expect(() =>
      assertNotSelfLockout(actor, "agent-2", { kind: "set-role", role: "viewer" }),
    ).not.toThrow();
    expect(() => assertNotSelfLockout(actor, "agent-2", { kind: "ban" })).not.toThrow();
  });
});

describe("createUserSchema", () => {
  const base = {
    name: "Sam",
    email: "Sam@Example.com",
    password: "long-enough-pass",
    role: "agent",
  };

  it("normalizes email to lower case and trims the name", () => {
    expect(createUserSchema.parse({ ...base, name: "  Sam  " })).toMatchObject({
      name: "Sam",
      email: "sam@example.com",
    });
  });

  it("rejects short passwords, unknown roles and bad emails", () => {
    expect(createUserSchema.safeParse({ ...base, password: "short" }).success).toBe(false);
    expect(createUserSchema.safeParse({ ...base, role: "owner" }).success).toBe(false);
    expect(createUserSchema.safeParse({ ...base, email: "nope" }).success).toBe(false);
  });
});
