import { describe, expect, it } from "vitest";
import { formatAge, humanize } from "./format";

describe("formatAge", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it.each([
    [0, "just now"],
    [59_000, "just now"],
    [5 * 60_000, "5m"],
    [3 * 3_600_000, "3h"],
    [2 * 86_400_000, "2d"],
    [42 * 86_400_000, "6w"],
  ])("%i ms ago is %s", (ms, expected) => {
    expect(formatAge(ago(ms), now)).toBe(expected);
  });

  it("treats future dates (clock skew) as just now", () => {
    expect(formatAge(new Date(now.getTime() + 60_000), now)).toBe("just now");
  });
});

describe("humanize", () => {
  it("turns enum values into labels", () => {
    expect(humanize("feature_request")).toBe("Feature request");
    expect(humanize("open")).toBe("Open");
  });
});
