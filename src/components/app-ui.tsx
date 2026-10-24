import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** App-specific pieces built on shadcn/ui primitives (which live in `components/ui/`). */

export function FieldError({ id, messages }: { id: string; messages?: string[] }) {
  if (!messages?.length) return null;
  return (
    <p id={id} className="text-sm text-destructive">
      {messages[0]}
    </p>
  );
}

/** Result message for a form action. Errors use role="alert"; success uses role="status". */
export function FormMessage({
  tone = "error",
  children,
}: {
  tone?: "error" | "success";
  children: ReactNode;
}) {
  return (
    <Alert
      variant={tone === "error" ? "destructive" : "default"}
      role={tone === "error" ? "alert" : "status"}
      className={cn(tone === "success" && "text-emerald-700 dark:text-emerald-400")}
    >
      <AlertDescription className="text-current">{children}</AlertDescription>
    </Alert>
  );
}

const roleBadge: Record<string, string> = {
  admin: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  agent: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  viewer: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

export function RoleBadge({ role }: { role: string }) {
  return (
    <Badge variant="secondary" className={cn("capitalize", roleBadge[role] ?? roleBadge.viewer)}>
      {role}
    </Badge>
  );
}

const priorityVariant = {
  urgent: "destructive",
  high: "default",
  normal: "secondary",
  low: "outline",
} as const;

/** Stored as low-urgent (matching the golden set); shown as P1-P4, the support-desk convention. */
export const PRIORITY_LABEL = { urgent: "P1", high: "P2", normal: "P3", low: "P4" } as const;

export function PriorityBadge({ priority }: { priority: keyof typeof priorityVariant }) {
  return (
    <Badge variant={priorityVariant[priority]} title={`Priority: ${priority}`}>
      {PRIORITY_LABEL[priority]}
      <span className="sr-only"> ({priority})</span>
    </Badge>
  );
}

const severityVariant = {
  sev1: "destructive",
  sev2: "default",
  sev3: "secondary",
  sev4: "outline",
} as const;

/** Incident severity, SEV1 (most severe) to SEV4. */
export function SeverityBadge({ severity }: { severity: keyof typeof severityVariant }) {
  return (
    <Badge variant={severityVariant[severity]} title={`Severity: ${severity}`}>
      {severity.toUpperCase()}
    </Badge>
  );
}

/** Marks text and labels produced by a model, so they are never mistaken for an agent's work. */
export function AiBadge() {
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      <Sparkles aria-hidden />
      AI
    </Badge>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className="capitalize">
      {status}
    </Badge>
  );
}

/** Marks seed rows, so demo data is never mistaken for real customer data. */
export function DemoBadge() {
  return (
    <Badge variant="outline" className="text-muted-foreground" title="Generated demo data">
      Demo
    </Badge>
  );
}

export function PageHeader({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
  );
}
