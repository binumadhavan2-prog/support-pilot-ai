import { describe, expect, it } from "vitest";
import { formatDuration } from "@/lib/format";
import { SLA_POLICY, slaClock, ticketSla, urgentClock } from "./sla";

const HOUR = 3_600_000;
const start = new Date("2026-10-27T08:00:00Z");
const at = (hours: number) => new Date(start.getTime() + hours * HOUR);

describe("slaClock", () => {
  it("runs on track, then at risk in the last quarter, then breached", () => {
    expect(slaClock(start, 8, null, at(1)).state).toBe("on_track");
    expect(slaClock(start, 8, null, at(6)).state).toBe("at_risk"); // 2h of 8h left
    expect(slaClock(start, 8, null, at(9))).toMatchObject({
      state: "breached",
      remainingMs: -HOUR,
    });
  });

  it("stops when done: met on time, breached when late", () => {
    expect(slaClock(start, 4, at(3), at(100))).toMatchObject({ state: "met", remainingMs: null });
    expect(slaClock(start, 4, at(5), at(5)).state).toBe("breached");
    expect(slaClock(start, 4, at(4), at(4)).state).toBe("met"); // exactly on the deadline
  });
});

describe("ticketSla", () => {
  it("uses the priority's targets for both clocks", () => {
    const sla = ticketSla(
      { priority: "urgent", createdAt: start, firstResponseAt: null, resolvedAt: null },
      at(0.5),
    );
    expect(sla.firstResponse.dueAt).toEqual(at(SLA_POLICY.urgent.firstResponseHours));
    expect(sla.resolution.dueAt).toEqual(at(SLA_POLICY.urgent.resolutionHours));
  });

  it("points at the clock that needs attention", () => {
    const answeredLate = ticketSla(
      { priority: "high", createdAt: start, firstResponseAt: at(1), resolvedAt: null },
      at(30),
    );
    // First response was met; the running resolution clock (24h) is overdue.
    expect(urgentClock(answeredLate)).toBe(answeredLate.resolution);
    const calm = ticketSla(
      { priority: "low", createdAt: start, firstResponseAt: null, resolvedAt: null },
      at(1),
    );
    expect(urgentClock(calm)).toBeNull();
  });
});

describe("formatDuration", () => {
  it("is compact and always positive", () => {
    expect(formatDuration(45 * 60_000)).toBe("45m");
    expect(formatDuration(-(3 * HOUR + 20 * 60_000))).toBe("3h 20m");
    expect(formatDuration(2 * 24 * HOUR + 4 * HOUR)).toBe("2d 4h");
    expect(formatDuration(10_000)).toBe("1m");
    expect(formatDuration(HOUR - 1_000)).toBe("59m");
  });
});
