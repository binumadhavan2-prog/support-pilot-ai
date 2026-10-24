import { describe, expect, it } from "vitest";
import { endLabelPositions, yTicks } from "./trend-chart";

describe("yTicks", () => {
  it("gives whole-number ticks from 0 that reach the maximum", () => {
    expect(yTicks(0)).toEqual([0, 1]);
    expect(yTicks(1)).toEqual([0, 1]);
    expect(yTicks(3)).toEqual([0, 1, 2, 3]);
    expect(yTicks(10)).toEqual([0, 3, 6, 9, 12]);
    expect(yTicks(100)).toEqual([0, 25, 50, 75, 100]);
  });
});

describe("endLabelPositions", () => {
  it("keeps labels at least 14px apart and above the baseline", () => {
    const both0 = endLabelPositions(200, 200, 200);
    expect(both0.created).toBeLessThanOrEqual(196);
    expect(both0.resolved).toBeLessThanOrEqual(196);
    expect(Math.abs(both0.created - both0.resolved)).toBeGreaterThanOrEqual(14);
    expect(endLabelPositions(50, 150, 200)).toEqual({ created: 54, resolved: 154 });
    const close = endLabelPositions(100, 95, 200); // resolved line is higher
    expect(close.resolved).toBeLessThan(close.created);
  });
});
