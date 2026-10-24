/**
 * Application RBAC. One place that answers "can this role do this?" for every route, server
 * action and page. Pure (no I/O) so it is exhaustively unit-tested.
 */
export const ROLES = ["admin", "agent", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = {
  "ticket:read": ["admin", "agent", "viewer"],
  "ticket:write": ["admin", "agent"],
  "draft:generate": ["admin", "agent"],
  "draft:review": ["admin", "agent"],
  "kb:ask": ["admin", "agent", "viewer"],
  "document:read": ["admin", "agent", "viewer"],
  "document:manage": ["admin"],
  "analytics:read": ["admin", "agent", "viewer"],
  "eval:run": ["admin"],
  "audit:read": ["admin"],
  "user:manage": ["admin"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Unknown or missing roles get no permissions (fail closed). */
export function can(role: unknown, permission: Permission): boolean {
  return isRole(role) && (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

export function permissionsFor(role: Role): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
}
