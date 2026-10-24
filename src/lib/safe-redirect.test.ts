import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "./safe-redirect";

describe("safeRedirectPath", () => {
  it.each(["/inbox", "/tickets?status=open", "/tickets/123#reply", "/"])(
    "allows same-origin path %j",
    (path) => {
      expect(safeRedirectPath(path)).toBe(path);
    },
  );

  it.each([
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    "dashboard",
    "/\t/evil.example",
    "/\n/evil.example",
    "",
    "/" + "a".repeat(600),
  ])("rejects unsafe target %j", (target) => {
    expect(safeRedirectPath(target)).toBe("/inbox");
  });

  it.each([undefined, null, 42, {}])("falls back for non-string %j", (target) => {
    expect(safeRedirectPath(target, "/home")).toBe("/home");
  });
});
