import { describe, expect, it } from "vitest";
import { can, isRole, PERMISSIONS, permissionsFor, ROLES, type Permission } from "./permissions";

describe("can", () => {
  // The full matrix, written out so any change to who-can-do-what shows up in review.
  const expected: Record<Permission, Record<(typeof ROLES)[number], boolean>> = {
    "ticket:read": { admin: true, agent: true, viewer: true },
    "ticket:write": { admin: true, agent: true, viewer: false },
    "incident:read": { admin: true, agent: true, viewer: true },
    "incident:manage": { admin: true, agent: true, viewer: false },
    "draft:generate": { admin: true, agent: true, viewer: false },
    "draft:review": { admin: true, agent: true, viewer: false },
    "kb:ask": { admin: true, agent: true, viewer: true },
    "document:read": { admin: true, agent: true, viewer: true },
    "document:manage": { admin: true, agent: false, viewer: false },
    "analytics:read": { admin: true, agent: true, viewer: true },
    "eval:run": { admin: true, agent: false, viewer: false },
    "audit:read": { admin: true, agent: false, viewer: false },
    "user:manage": { admin: true, agent: false, viewer: false },
  };

  it("covers every defined permission", () => {
    expect(Object.keys(expected).sort()).toEqual(Object.keys(PERMISSIONS).sort());
  });

  for (const [permission, byRole] of Object.entries(expected)) {
    for (const [role, allowed] of Object.entries(byRole)) {
      it(`${role} ${allowed ? "can" : "cannot"} ${permission}`, () => {
        expect(can(role, permission as Permission)).toBe(allowed);
      });
    }
  }

  it.each([undefined, null, "", "user", "ADMIN", "superadmin", 1, {}])(
    "denies everything to an unknown role (%j)",
    (role) => {
      for (const permission of Object.keys(PERMISSIONS) as Permission[]) {
        expect(can(role, permission)).toBe(false);
      }
    },
  );
});

describe("isRole / permissionsFor", () => {
  it("recognizes exactly the three roles", () => {
    expect(ROLES.every(isRole)).toBe(true);
    expect(isRole("owner")).toBe(false);
  });

  it("gives viewers read-only permissions", () => {
    expect(permissionsFor("viewer").every((p) => /:(read|ask)$/.test(p))).toBe(true);
  });

  it("gives admins every permission", () => {
    expect(permissionsFor("admin")).toHaveLength(Object.keys(PERMISSIONS).length);
  });
});
