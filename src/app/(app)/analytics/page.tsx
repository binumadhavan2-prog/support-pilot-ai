import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-ui";
import { BarList, StackedBar, StatTile } from "@/components/charts";
import { TrendChart } from "@/components/trend-chart";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getDb } from "@/db/client";
import { humanize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ANALYTICS_RANGES, getAnalytics, parseRange } from "@/server/analytics";
import { requirePagePermission } from "@/server/auth/session";

export const metadata: Metadata = { title: "Analytics · Support Pilot AI" };

export default function Page({ searchParams }: PageProps<"/analytics">) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Analytics"
        description="Ticket volume, response times and how the AI is used."
      />
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

const PRIORITY_LABEL: Record<string, string> = {
  urgent: "P1 · Urgent",
  high: "P2 · High",
  normal: "P3 · Normal",
  low: "P4 · Low",
};

/** "45 min", "3.2 h", "2.1 d", or an em dash when there is no data. */
function duration(hours: number | null) {
  if (hours === null) return "—";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} d`;
}

const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((n / d) * 100)}%`);
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

async function Content({ searchParams }: Pick<PageProps<"/analytics">, "searchParams">) {
  const user = await requirePagePermission("analytics:read");
  const days = parseRange((await searchParams).days);
  const a = await getAnalytics(getDb(), user.tenantId, days);
  const d = a.drafts;
  const reviewed = d.approved + d.edited + d.rejected;

  return (
    <>
      <nav aria-label="Time range" className="flex items-center gap-1 text-sm">
        <span className="mr-2 text-muted-foreground">Last</span>
        {ANALYTICS_RANGES.map((r) => (
          <Link
            key={r}
            href={r === 30 ? "/analytics" : `/analytics?days=${r}`}
            aria-current={r === days ? "page" : undefined}
            className={cn(
              "rounded-md px-2.5 py-1",
              r === days ? "bg-secondary font-medium" : "text-muted-foreground hover:bg-muted",
            )}
          >
            {r} days
          </Link>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">Days are in UTC</span>
      </nav>

      <section aria-label="Ticket summary" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile label="Tickets created" value={a.tickets.created} />
        <StatTile label="Resolved" value={a.tickets.resolved} />
        <StatTile
          label="Open backlog"
          value={a.tickets.backlog}
          detail="Open or pending, right now"
        />
        <StatTile
          label="Median first response"
          value={duration(a.tickets.medianFirstResponseHours)}
          detail={`${a.tickets.answered} of ${a.tickets.created} answered · ${pct(a.tickets.answeredWithinSla, a.tickets.answered)} within SLA`}
        />
        <StatTile
          label="Median time to resolve"
          value={duration(a.tickets.medianResolutionHours)}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Tickets per day</CardTitle>
          <CardDescription>Created and resolved, last {days} days.</CardDescription>
        </CardHeader>
        <CardContent>
          <TrendChart data={a.daily} />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>By status</CardTitle>
            <CardDescription>All tickets, right now.</CardDescription>
          </CardHeader>
          <CardContent>
            <BarList rows={a.byStatus.map((r) => ({ label: humanize(r.key), value: r.n }))} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>By priority</CardTitle>
            <CardDescription>Tickets created in this period.</CardDescription>
          </CardHeader>
          <CardContent>
            <BarList
              rows={a.byPriority.map((r) => ({ label: PRIORITY_LABEL[r.key], value: r.n }))}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>By category</CardTitle>
            <CardDescription>Set by AI triage; tickets created in this period.</CardDescription>
          </CardHeader>
          <CardContent>
            <BarList rows={a.byCategory.map((r) => ({ label: humanize(r.key), value: r.n }))} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>AI draft replies</CardTitle>
            <CardDescription>
              {d.total === 0
                ? "No drafts in this period."
                : `${d.total} drafted · ${pct(d.grounded, d.total)} from help articles · ${pct(d.approved + d.edited, reviewed)} of reviewed drafts approved · ${pct(d.edited, d.approved + d.edited)} of approvals edited first`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {d.total > 0 && (
              <StackedBar
                parts={[
                  { label: "Approved as written", value: d.approved },
                  { label: "Edited, then approved", value: d.edited },
                  { label: "Rejected or replaced", value: d.rejected },
                  { label: "Waiting for review", value: d.pending },
                ]}
              />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Open tickets by owner</CardTitle>
            <CardDescription>Open or pending, right now.</CardDescription>
          </CardHeader>
          <CardContent>
            <BarList
              rows={a.workload.map((w) => ({ label: w.name, value: w.n }))}
              emptyText="No open tickets."
            />
          </CardContent>
        </Card>
      </div>

      <section aria-label="AI usage" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="AI triage runs"
          value={a.triage.runs}
          detail={
            a.triage.avgLatencyMs === null
              ? "No runs yet"
              : `Avg ${(a.triage.avgLatencyMs / 1000).toFixed(1)} s per ticket`
          }
        />
        <StatTile
          label="Injection attempts flagged"
          value={a.triage.injections}
          detail={`${pct(a.triage.injections, a.triage.runs)} of triaged tickets`}
        />
        <StatTile
          label="Knowledge-base questions"
          value={a.kb.questions}
          detail={`${pct(a.kb.grounded, a.kb.questions)} answered from documents`}
        />
        <StatTile
          label="Claude tokens"
          value={compact.format(a.tokens.input + a.tokens.output)}
          detail={`${compact.format(a.tokens.input)} in · ${compact.format(a.tokens.output)} out`}
        />
      </section>
    </>
  );
}
