import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/*
 * Server-rendered chart pieces for the analytics page. Colors come from the --viz-* tokens in
 * globals.css (validated palette, light and dark). Every mark has a visible value label, so
 * nothing is read from color alone.
 */

/** A headline number. Not a chart: a single value needs no axes. */
export function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <Card className="gap-1 py-4">
      <CardContent className="flex flex-col gap-1 px-4">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="text-2xl font-semibold tracking-tight">{value}</span>
        {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
      </CardContent>
    </Card>
  );
}

/**
 * Horizontal bars for one measure across categories (one hue: it's magnitude, not identity).
 * Labels and values are text, so the list doubles as its own table.
 */
export function BarList({
  rows,
  emptyText = "No data in this period.",
}: {
  rows: { label: string; value: number }[];
  emptyText?: string;
}) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (max === 0) return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[7.5rem_1fr_2.5rem] items-center gap-3 text-sm">
          <span className="truncate text-muted-foreground">{r.label}</span>
          <span
            className="h-2 overflow-hidden rounded-r bg-[var(--viz-grid)]/40"
            role="img"
            aria-label={`${r.label}: ${r.value}`}
            title={`${r.label}: ${r.value}`}
          >
            <span
              className="block h-full rounded-r-[4px] bg-[var(--viz-series-1)]"
              style={{ width: r.value === 0 ? 0 : `max(4px, ${(r.value / max) * 100}%)` }}
            />
          </span>
          <span className="text-right tabular-nums">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}

const SLOT_VARS = ["--viz-series-1", "--viz-series-2", "--viz-series-3", "--viz-series-4"];

/**
 * One 100% bar split into up to four parts (fixed slot order), with a 2px surface gap between
 * segments and a legend carrying each part's count and share.
 */
export function StackedBar({ parts }: { parts: { label: string; value: number }[] }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (total === 0) return <p className="text-sm text-muted-foreground">No data in this period.</p>;
  const pct = (v: number) => Math.round((v / total) * 100);
  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex h-3 gap-0.5"
        role="img"
        aria-label={parts.map((p) => `${p.label} ${p.value}`).join(", ")}
      >
        {parts.map((p, i) =>
          p.value === 0 ? null : (
            <span
              key={p.label}
              title={`${p.label}: ${p.value} (${pct(p.value)}%)`}
              className={cn("h-full first:rounded-l-[4px] last:rounded-r-[4px]")}
              style={{ flexGrow: p.value, flexBasis: 0, background: `var(${SLOT_VARS[i]})` }}
            />
          ),
        )}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
        {parts.map((p, i) => (
          <li key={p.label} className="flex items-center gap-1.5">
            <span
              className="size-2.5 rounded-sm"
              style={{ background: `var(${SLOT_VARS[i]})` }}
              aria-hidden
            />
            <span className="text-muted-foreground">{p.label}</span>
            <span className="tabular-nums">
              {p.value} ({pct(p.value)}%)
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
