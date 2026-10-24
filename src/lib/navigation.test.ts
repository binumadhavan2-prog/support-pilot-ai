import { describe, expect, it } from "vitest";
import { isNavItemActive, NAV_ITEMS, navItemsFor } from "./navigation";

const labels = (role: Parameters<typeof navItemsFor>[0]) => navItemsFor(role).map((i) => i.label);

describe("navItemsFor", () => {
  it("shows every section to admins and agents", () => {
    const all = NAV_ITEMS.map((i) => i.label);
    expect(labels("admin")).toEqual(all);
    expect(labels("agent")).toEqual(all);
  });

  it("hides Approvals from viewers, who cannot review drafts", () => {
    expect(labels("viewer")).toEqual([
      "Inbox",
      "Incidents",
      "Analytics",
      "Knowledge Base",
      "Settings",
    ]);
  });
});

describe("isNavItemActive", () => {
  it("matches the page and its sub-pages", () => {
    expect(isNavItemActive("/settings", "/settings")).toBe(true);
    expect(isNavItemActive("/settings", "/settings/users")).toBe(true);
  });

  it("does not match a different page that shares a prefix", () => {
    expect(isNavItemActive("/inbox", "/inboxes")).toBe(false);
    expect(isNavItemActive("/inbox", "/")).toBe(false);
  });
});
