import { can, type Permission, type Role } from "@/server/auth/permissions";

/**
 * Sidebar destinations. Hiding an item is a convenience only: each page enforces the same
 * permission on the server with `requirePagePermission`.
 */
export const NAV_ITEMS = [
  { href: "/inbox", label: "Inbox", icon: "inbox", permission: "ticket:read" },
  { href: "/approvals", label: "Approvals", icon: "approvals", permission: "draft:review" },
  { href: "/incidents", label: "Incidents", icon: "incidents", permission: "incident:read" },
  { href: "/analytics", label: "Analytics", icon: "analytics", permission: "analytics:read" },
  { href: "/knowledge", label: "Knowledge Base", icon: "knowledge", permission: "document:read" },
  { href: "/settings", label: "Settings", icon: "settings", permission: null },
] as const satisfies readonly {
  href: string;
  label: string;
  icon: string;
  permission: Permission | null;
}[];

export type NavItem = (typeof NAV_ITEMS)[number];
export type NavIcon = NavItem["icon"];

export function navItemsFor(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => item.permission === null || can(role, item.permission));
}

/** True when `pathname` is the item's page or one of its sub-pages. */
export function isNavItemActive(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
