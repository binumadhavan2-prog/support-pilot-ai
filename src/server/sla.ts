import { sql, type SQL } from "drizzle-orm";
import { tickets } from "@/db/schema";

/*
 * Service-level targets: how fast a ticket must get its first reply and be resolved, by priority.
 * Computed when read (never stored), so changing a target applies to every ticket at once with no
 * migration. Clocks run in calendar hours from ticket creation; there are no business hours and the
 * clock does not pause while the ticket waits on the customer.
 */

type Priority = (typeof tickets.$inferSelect)["priority"];

export const SLA_POLICY: Record<Priority, { firstResponseHours: number; resolutionHours: number }> =
  {
    urgent: { firstResponseHours: 1, resolutionHours: 8 },
    high: { firstResponseHours: 4, resolutionHours: 24 },
    normal: { firstResponseHours: 8, resolutionHours: 72 },
    low: { firstResponseHours: 24, resolutionHours: 168 },
  };

/** A running clock is "at risk" in the last quarter of its target. */
export const AT_RISK_FRACTION = 0.25;

export type SlaState = "met" | "breached" | "on_track" | "at_risk";

export interface SlaClock {
  state: SlaState;
  dueAt: Date;
  targetHours: number;
  /** Milliseconds left (negative once overdue); null when the clock has stopped. */
  remainingMs: number | null;
}

const HOUR_MS = 3_600_000;

export function slaClock(
  startedAt: Date,
  targetHours: number,
  doneAt: Date | null,
  now: Date,
): SlaClock {
  const dueAt = new Date(startedAt.getTime() + targetHours * HOUR_MS);
  if (doneAt) {
    return { state: doneAt <= dueAt ? "met" : "breached", dueAt, targetHours, remainingMs: null };
  }
  const remainingMs = dueAt.getTime() - now.getTime();
  const state =
    remainingMs < 0
      ? "breached"
      : remainingMs <= targetHours * HOUR_MS * AT_RISK_FRACTION
        ? "at_risk"
        : "on_track";
  return { state, dueAt, targetHours, remainingMs };
}

export function ticketSla(
  ticket: {
    priority: Priority;
    createdAt: Date;
    firstResponseAt: Date | null;
    resolvedAt: Date | null;
  },
  now: Date,
) {
  const policy = SLA_POLICY[ticket.priority];
  return {
    firstResponse: slaClock(
      ticket.createdAt,
      policy.firstResponseHours,
      ticket.firstResponseAt,
      now,
    ),
    resolution: slaClock(ticket.createdAt, policy.resolutionHours, ticket.resolvedAt, now),
  };
}

/** The clock that needs attention first: an open breach, then at risk, else the first response. */
export function urgentClock(sla: ReturnType<typeof ticketSla>) {
  const running = [sla.firstResponse, sla.resolution].filter((c) => c.remainingMs !== null);
  return (
    running.find((c) => c.state === "breached") ??
    running.find((c) => c.state === "at_risk") ??
    null
  );
}

// --- The same rules in SQL, for inbox filters and analytics. ---

// The policy values are compile-time constants (enum names and integers), so they are inlined as
// literals: bound parameters would leave Postgres guessing their types inside CASE / make_interval.
function hoursFor(kind: "firstResponseHours" | "resolutionHours"): SQL {
  const cases = (Object.keys(SLA_POLICY) as Priority[])
    .map((p) => `when '${p}' then ${Math.trunc(SLA_POLICY[p][kind])}`)
    .join(" ");
  return sql`(case ${tickets.priority} ${sql.raw(cases)} end)`;
}

export const firstResponseDueSql = sql`${tickets.createdAt} + make_interval(hours => ${hoursFor("firstResponseHours")})`;
export const resolutionDueSql = sql`${tickets.createdAt} + make_interval(hours => ${hoursFor("resolutionHours")})`;

/** Running clocks only: unanswered and past the first-response target, or unresolved and late. */
export const slaOverdueSql = sql`((${tickets.firstResponseAt} is null and now() > ${firstResponseDueSql}) or (${tickets.resolvedAt} is null and now() > ${resolutionDueSql}))`;

/** Running clocks in their last quarter, not yet overdue. */
export const slaAtRiskSql = sql`(not ${slaOverdueSql} and ((${tickets.firstResponseAt} is null and now() > ${firstResponseDueSql} - make_interval(hours => ${hoursFor("firstResponseHours")}) * ${sql.raw(String(AT_RISK_FRACTION))}) or (${tickets.resolvedAt} is null and now() > ${resolutionDueSql} - make_interval(hours => ${hoursFor("resolutionHours")}) * ${sql.raw(String(AT_RISK_FRACTION))})))`;

/** For analytics: answered tickets whose first reply came within the target. */
export const firstResponseMetSql = sql`(${tickets.firstResponseAt} is not null and ${tickets.firstResponseAt} <= ${firstResponseDueSql})`;
