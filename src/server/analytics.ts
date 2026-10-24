import { and, count, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { aiDrafts, kbQueries, tickets, triageResults, user } from "@/db/schema";
import { ticketCategory, ticketPriority, ticketStatus } from "@/db/schema/enums";
import type { AnyDatabase } from "@/db/types";

export const ANALYTICS_RANGES = [7, 30, 90] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

/** `?days=` from the URL; anything other than 7, 30 or 90 means 30. */
export function parseRange(value: unknown): AnalyticsRange {
  const n = Number(value);
  return (ANALYTICS_RANGES as readonly number[]).includes(n) ? (n as AnalyticsRange) : 30;
}

const DAY_MS = 86_400_000;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * Support and AI metrics for one tenant over the last `days` days (UTC). Every query filters by
 * tenant. "Created" and AI activity count events inside the window; backlog and workload are the
 * current state.
 */
export async function getAnalytics(
  db: AnyDatabase,
  tenantId: string,
  days: AnalyticsRange,
  now = new Date(),
) {
  // Whole UTC days: the window starts at midnight `days - 1` days ago, so the chart has `days` bars.
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const since = new Date(today - (days - 1) * DAY_MS);
  const mine = eq(tickets.tenantId, tenantId);

  const [created] = await db
    .select({
      total: count(),
      // Median hours from creation to first agent reply, over tickets answered so far.
      medianFirstResponseH: sql<
        number | null
      >`percentile_cont(0.5) within group (order by extract(epoch from ${tickets.firstResponseAt} - ${tickets.createdAt}) / 3600) filter (where ${tickets.firstResponseAt} is not null)`,
      answered: sql<number>`count(*) filter (where ${tickets.firstResponseAt} is not null)`,
    })
    .from(tickets)
    .where(and(mine, gte(tickets.createdAt, since)));

  const [resolved] = await db
    .select({
      total: count(),
      medianResolutionH: sql<
        number | null
      >`percentile_cont(0.5) within group (order by extract(epoch from ${tickets.resolvedAt} - ${tickets.createdAt}) / 3600)`,
    })
    .from(tickets)
    .where(and(mine, isNotNull(tickets.resolvedAt), gte(tickets.resolvedAt, since)));

  const [backlog] = await db
    .select({ total: count() })
    .from(tickets)
    .where(and(mine, inArray(tickets.status, ["open", "pending"])));

  const day = (column: typeof tickets.createdAt | typeof tickets.resolvedAt) =>
    sql<string>`to_char(date_trunc('day', ${column} at time zone 'UTC'), 'YYYY-MM-DD')`;
  const [createdByDay, resolvedByDay] = await Promise.all([
    db
      .select({ day: day(tickets.createdAt), n: count() })
      .from(tickets)
      .where(and(mine, gte(tickets.createdAt, since)))
      .groupBy(day(tickets.createdAt)),
    db
      .select({ day: day(tickets.resolvedAt), n: count() })
      .from(tickets)
      .where(and(mine, isNotNull(tickets.resolvedAt), gte(tickets.resolvedAt, since)))
      .groupBy(day(tickets.resolvedAt)),
  ]);
  const createdMap = new Map(createdByDay.map((r) => [r.day, Number(r.n)]));
  const resolvedMap = new Map(resolvedByDay.map((r) => [r.day, Number(r.n)]));
  const daily = Array.from({ length: days }, (_, i) => {
    const date = new Date(since.getTime() + i * DAY_MS).toISOString().slice(0, 10);
    return { date, created: createdMap.get(date) ?? 0, resolved: resolvedMap.get(date) ?? 0 };
  });

  const [byStatus, byPriority, byCategory] = await Promise.all([
    db
      .select({ key: tickets.status, n: count() })
      .from(tickets)
      .where(mine)
      .groupBy(tickets.status),
    db
      .select({ key: tickets.priority, n: count() })
      .from(tickets)
      .where(and(mine, gte(tickets.createdAt, since)))
      .groupBy(tickets.priority),
    db
      .select({ key: sql<string>`coalesce(${tickets.category}::text, 'untriaged')`, n: count() })
      .from(tickets)
      .where(and(mine, gte(tickets.createdAt, since)))
      .groupBy(sql`coalesce(${tickets.category}::text, 'untriaged')`),
  ]);
  const breakdown = <K extends string>(keys: readonly K[], rows: { key: string; n: number }[]) =>
    keys.map((key) => ({ key, n: Number(rows.find((r) => r.key === key)?.n ?? 0) }));

  const draftRows = await db
    .select({
      status: aiDrafts.status,
      n: count(),
      grounded: sql<number>`count(*) filter (where ${aiDrafts.groundingStatus} = 'grounded')`,
    })
    .from(aiDrafts)
    .where(and(eq(aiDrafts.tenantId, tenantId), gte(aiDrafts.createdAt, since)))
    .groupBy(aiDrafts.status);
  const draftCount = (s: string) => Number(draftRows.find((r) => r.status === s)?.n ?? 0);
  const drafts = {
    approved: draftCount("approved"),
    edited: draftCount("edited"),
    // Superseded drafts are recorded as rejected by the system; they still count as not used.
    rejected: draftCount("rejected"),
    pending: draftCount("pending"),
    total: draftRows.reduce((s, r) => s + Number(r.n), 0),
    grounded: draftRows.reduce((s, r) => s + Number(r.grounded), 0),
  };

  const [triage] = await db
    .select({
      runs: count(),
      injections: sql<number>`count(*) filter (where ${triageResults.isInjection})`,
      avgLatencyMs: sql<number | null>`avg(${triageResults.latencyMs})`,
      inputTokens: sql<number>`coalesce(sum(${triageResults.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${triageResults.outputTokens}), 0)`,
    })
    .from(triageResults)
    .where(and(eq(triageResults.tenantId, tenantId), gte(triageResults.createdAt, since)));

  const [kb] = await db
    .select({
      questions: count(),
      grounded: sql<number>`count(*) filter (where ${kbQueries.groundingStatus} = 'grounded')`,
      inputTokens: sql<number>`coalesce(sum(${kbQueries.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${kbQueries.outputTokens}), 0)`,
    })
    .from(kbQueries)
    .where(and(eq(kbQueries.tenantId, tenantId), gte(kbQueries.createdAt, since)));

  const [draftTokens] = await db
    .select({
      inputTokens: sql<number>`coalesce(sum(${aiDrafts.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${aiDrafts.outputTokens}), 0)`,
    })
    .from(aiDrafts)
    .where(and(eq(aiDrafts.tenantId, tenantId), gte(aiDrafts.createdAt, since)));

  const workload = await db
    .select({ name: sql<string>`coalesce(${user.name}, 'Unassigned')`, n: count() })
    .from(tickets)
    .leftJoin(user, eq(user.id, tickets.assigneeId))
    .where(and(mine, inArray(tickets.status, ["open", "pending"])))
    .groupBy(tickets.assigneeId, user.name)
    .orderBy(desc(count()));

  return {
    days,
    since,
    tickets: {
      created: Number(created.total),
      answered: Number(created.answered),
      resolved: Number(resolved.total),
      backlog: Number(backlog.total),
      medianFirstResponseHours: num(created.medianFirstResponseH),
      medianResolutionHours: num(resolved.medianResolutionH),
    },
    daily,
    byStatus: breakdown(ticketStatus.enumValues, byStatus),
    byPriority: breakdown(ticketPriority.enumValues, byPriority).reverse(), // urgent first
    byCategory: breakdown([...ticketCategory.enumValues, "untriaged"] as const, byCategory),
    drafts,
    triage: {
      runs: Number(triage.runs),
      injections: Number(triage.injections),
      avgLatencyMs: num(triage.avgLatencyMs),
    },
    kb: { questions: Number(kb.questions), grounded: Number(kb.grounded) },
    tokens: {
      input: Number(triage.inputTokens) + Number(kb.inputTokens) + Number(draftTokens.inputTokens),
      output:
        Number(triage.outputTokens) + Number(kb.outputTokens) + Number(draftTokens.outputTokens),
    },
    workload: workload.map((w) => ({ name: w.name, n: Number(w.n) })),
  };
}

export type Analytics = Awaited<ReturnType<typeof getAnalytics>>;
