"use client";

import { useEffect, useRef, useState } from "react";

/*
 * Created vs resolved per day: two 2px lines on one axis, a hover crosshair with a tooltip for
 * the nearest day, direct labels at the line ends, and a table view. Colors are the first two
 * fixed palette slots (--viz-series-1/2).
 */

interface Point {
  date: string; // YYYY-MM-DD
  created: number;
  resolved: number;
}

// Drawn at the container's real width (measured), so 11px text stays 11px on any screen.
const DEFAULT_W = 960;
const H = 260;
const PAD = { top: 12, right: 88, bottom: 28, left: 32 };

const SERIES = [
  { key: "created", label: "Created", color: "var(--viz-series-1)" },
  { key: "resolved", label: "Resolved", color: "var(--viz-series-2)" },
] as const;

const shortDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

/** Whole-number ticks from 0 up to the first step at or above `max` (at most 5). */
export function yTicks(max: number) {
  const step = Math.max(1, Math.ceil(max / 4));
  const count = Math.max(1, Math.ceil(max / step));
  return Array.from({ length: count + 1 }, (_, i) => i * step);
}

/**
 * Vertical positions for the two end labels: next to their line, at least 14px apart, and never
 * below the baseline (where they would collide with the date labels).
 */
export function endLabelPositions(createdY: number, resolvedY: number, baseline: number) {
  const GAP = 14;
  const limit = baseline - 4;
  let created = Math.min(createdY + 4, limit);
  let resolved = Math.min(resolvedY + 4, limit);
  if (Math.abs(created - resolved) < GAP) {
    // Keep the higher line's label on top; push the pair up if the lower one hits the limit.
    const createdOnTop = createdY <= resolvedY;
    const low = Math.min(Math.max(created, resolved), limit);
    const high = low - GAP;
    created = createdOnTop ? high : low;
    resolved = createdOnTop ? low : high;
  }
  return { created, resolved };
}

export function TrendChart({ data }: { data: Point[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(DEFAULT_W);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(([entry]) =>
      setW(Math.max(280, Math.round(entry.contentRect.width))),
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  const max = Math.max(0, ...data.flatMap((d) => [d.created, d.resolved]));
  const ticks = yTicks(max);
  const top = ticks.at(-1) ?? 1;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) =>
    PAD.left + (data.length <= 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / top) * innerH;
  const path = (key: "created" | "resolved") =>
    data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join("");
  // About 6 date labels whatever the range.
  // One date label per ~110px, so labels never crowd on a phone.
  const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(innerW / 110))));
  const last = data.length - 1;
  const hovered = hover === null ? null : data[hover];
  const endLabelY = endLabelPositions(
    y(data[last].created),
    y(data[last].resolved),
    PAD.top + innerH,
  );

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex gap-5 text-sm" aria-label="Legend">
        {SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded" style={{ background: s.color }} aria-hidden />
            {s.label}
          </li>
        ))}
      </ul>
      <div ref={boxRef} className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full overflow-visible"
          role="img"
          aria-label={`Tickets created and resolved per day, ${shortDate(data[0].date)} to ${shortDate(data[last].date)}`}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y(t)}
                y2={y(t)}
                stroke={t === 0 ? "var(--viz-baseline)" : "var(--viz-grid)"}
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                className="fill-muted-foreground text-[11px] tabular-nums"
              >
                {t}
              </text>
            </g>
          ))}
          {data.map((d, i) =>
            i % every === 0 || i === last ? (
              <text
                key={d.date}
                x={x(i)}
                y={H - 8}
                textAnchor="middle"
                className="fill-muted-foreground text-[11px]"
              >
                {shortDate(d.date)}
              </text>
            ) : null,
          )}
          {hover !== null && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={PAD.top + innerH}
              stroke="var(--viz-baseline)"
              strokeWidth={1}
            />
          )}
          {SERIES.map((s) => (
            <g key={s.key}>
              <path
                d={path(s.key)}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {/* Direct label at the line end, in text ink; the line beside it carries the color. */}
              <text x={x(last) + 8} y={endLabelY[s.key]} className="fill-foreground text-[11px]">
                {s.label} {data[last][s.key]}
              </text>
              {hover !== null && (
                <circle
                  cx={x(hover)}
                  cy={y(data[hover][s.key])}
                  r={4}
                  fill={s.color}
                  stroke="var(--card)"
                  strokeWidth={2}
                />
              )}
            </g>
          ))}
          {/* Hit targets: one full-height column per day, wider than the marks. */}
          {data.map((d, i) => (
            <rect
              key={d.date}
              x={x(i) - innerW / Math.max(1, data.length - 1) / 2}
              y={PAD.top}
              width={innerW / Math.max(1, data.length - 1)}
              height={innerH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>
        {hovered && hover !== null && (
          <div
            className="pointer-events-none absolute top-0 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-sm"
            style={{
              left: `${(x(hover) / W) * 100}%`,
              transform: x(hover) > W / 2 ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
            }}
          >
            <div className="font-medium">{shortDate(hovered.date)}</div>
            {SERIES.map((s) => (
              <div key={s.key} className="flex items-center gap-1.5">
                <span className="h-0.5 w-3 rounded" style={{ background: s.color }} aria-hidden />
                {s.label}: <span className="tabular-nums">{hovered[s.key]}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">View as table</summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full text-left tabular-nums">
            <thead>
              <tr className="text-muted-foreground">
                <th className="py-1 font-medium">Day (UTC)</th>
                <th className="py-1 text-right font-medium">Created</th>
                <th className="py-1 text-right font-medium">Resolved</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.date} className="border-t">
                  <td className="py-1">{shortDate(d.date)}</td>
                  <td className="py-1 text-right">{d.created}</td>
                  <td className="py-1 text-right">{d.resolved}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
