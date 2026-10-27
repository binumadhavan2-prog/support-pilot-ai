import { AlarmClock, CircleCheck, Clock, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SlaClock } from "@/server/sla";

/* SLA display. Clocks are computed on the server at request time (src/server/sla.ts). */

/** Inbox badge for a ticket whose running clock is overdue or at risk; nothing otherwise. */
export function SlaBadge({ clock }: { clock: SlaClock | null }) {
  if (!clock || clock.remainingMs === null) return null;
  if (clock.state === "breached") {
    return (
      <Badge variant="destructive" title={`Was due ${formatDateTime(clock.dueAt)}`}>
        <AlarmClock aria-hidden />
        SLA overdue {formatDuration(clock.remainingMs)}
      </Badge>
    );
  }
  if (clock.state === "at_risk") {
    return (
      <Badge variant="outline" title={`Due ${formatDateTime(clock.dueAt)}`}>
        <Clock aria-hidden />
        Due in {formatDuration(clock.remainingMs)}
      </Badge>
    );
  }
  return null;
}

const STATE_VIEW = {
  met: { icon: CircleCheck, className: "text-muted-foreground" },
  on_track: { icon: Clock, className: "text-muted-foreground" },
  at_risk: { icon: TriangleAlert, className: "text-foreground font-medium" },
  breached: { icon: AlarmClock, className: "text-destructive font-medium" },
} as const;

function describe(clock: SlaClock) {
  if (clock.remainingMs === null) return clock.state === "met" ? "Met" : "Missed";
  if (clock.state === "breached") return `Overdue by ${formatDuration(clock.remainingMs)}`;
  return `Due in ${formatDuration(clock.remainingMs)}`;
}

/** One line per clock on the ticket page: label, state and the due time. */
export function SlaLine({ label, clock }: { label: string; clock: SlaClock }) {
  const { icon: Icon, className } = STATE_VIEW[clock.state];
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("flex items-center gap-1.5 text-right", className)}>
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span>
          {describe(clock)}
          <span className="block text-xs font-normal text-muted-foreground">
            target {clock.targetHours}h · {formatDateTime(clock.dueAt)}
          </span>
        </span>
      </span>
    </div>
  );
}
