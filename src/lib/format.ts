const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact age for list views: "just now", "5m", "3h", "2d", "6w". */
export function formatAge(from: Date, now: Date): string {
  const ms = Math.max(0, now.getTime() - from.getTime());
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  if (ms < 14 * DAY) return `${Math.floor(ms / DAY)}d`;
  return `${Math.floor(ms / (7 * DAY))}w`;
}

/** "feature_request" -> "Feature request". */
export function humanize(value: string): string {
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const dateTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

export function formatDateTime(date: Date): string {
  return dateTime.format(date);
}

/** A span for SLA clocks: "45m", "3h 20m", "2d 4h". Always positive; the caller says due / overdue. */
export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  // Rounded down, so a deadline never looks further away than it is (59.9 minutes is "59m").
  if (abs < HOUR) return `${Math.max(1, Math.floor(abs / MINUTE))}m`;
  if (abs < DAY) {
    const minutes = Math.floor((abs % HOUR) / MINUTE);
    return minutes ? `${Math.floor(abs / HOUR)}h ${minutes}m` : `${Math.floor(abs / HOUR)}h`;
  }
  const hours = Math.floor((abs % DAY) / HOUR);
  return hours ? `${Math.floor(abs / DAY)}d ${hours}h` : `${Math.floor(abs / DAY)}d`;
}
