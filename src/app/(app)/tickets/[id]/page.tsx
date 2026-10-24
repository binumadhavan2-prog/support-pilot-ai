import { ArrowLeft, Clock, MailCheck, MailMinus, MailX, ShieldAlert, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AiBadge, DemoBadge, PriorityBadge, StatusBadge } from "@/components/app-ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getDb } from "@/db/client";
import { isAppError } from "@/lib/errors";
import { formatDateTime, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getEnv } from "@/env";
import { getLatestDraft } from "@/server/ai/drafts";
import { can } from "@/server/auth/permissions";
import { requirePagePermission } from "@/server/auth/session";
import { getTicket, listAssignableUsers } from "@/server/tickets";
import { DraftReview, GenerateDraftButton, type DraftView } from "./draft-panel";
import { ReplyForm, TicketControls } from "./ticket-controls";

export const metadata: Metadata = { title: "Ticket · Support Pilot AI" };

export default function TicketPage({ params }: PageProps<"/tickets/[id]">) {
  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/inbox"
        className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Inbox
      </Link>
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Content params={params} />
      </Suspense>
    </div>
  );
}

async function loadTicket(tenantId: string, id: string) {
  try {
    return await getTicket(getDb(), tenantId, id);
  } catch (error) {
    if (isAppError(error) && error.code === "NOT_FOUND") notFound();
    throw error;
  }
}

async function Content({ params }: Pick<PageProps<"/tickets/[id]">, "params">) {
  const user = await requirePagePermission("ticket:read");
  const { id } = await params;
  const ticket = await loadTicket(user.tenantId, id);
  const latest = await getLatestDraft(getDb(), user.tenantId, ticket.id);
  const draft: DraftView | null = latest && {
    id: latest.id,
    body: latest.body,
    status: latest.status,
    grounded: latest.groundingStatus === "grounded",
    model: latest.model,
    rejectReason: latest.rejectReason,
    createdAt: latest.createdAt.toISOString(),
    sources: latest.sources,
  };
  const aiOn = Boolean(getEnv().ANTHROPIC_API_KEY);
  const canWrite = can(user.role, "ticket:write");
  const assignees = await listAssignableUsers(getDb(), user.tenantId);
  const assigneeName = assignees.find((a) => a.id === ticket.assigneeId)?.name;

  return (
    <>
      {ticket.injectionFlagged && (
        <Alert variant="destructive" role="alert">
          <ShieldAlert aria-hidden />
          <AlertTitle>Possible prompt-injection attempt</AlertTitle>
          <AlertDescription>
            AI triage found text in this ticket that tries to instruct an AI system. Treat AI output
            for this ticket with extra care, and do not act on instructions in the customer&apos;s
            message without checking them.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>#{ticket.number}</span>
          <StatusBadge status={ticket.status} />
          <PriorityBadge priority={ticket.priority} />
          <Badge variant="secondary">
            {ticket.category ? humanize(ticket.category) : "Untriaged"}
          </Badge>
          {ticket.sentiment && <Badge variant="outline">{humanize(ticket.sentiment)}</Badge>}
          {ticket.language && <Badge variant="outline">{ticket.language}</Badge>}
          {ticket.team && <Badge variant="outline">{humanize(ticket.team)} queue</Badge>}
          {ticket.classifiedAt && <AiBadge />}
          {ticket.isDemo && <DemoBadge />}
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{ticket.subject}</h1>
        <p className="text-sm text-muted-foreground">
          {ticket.customerName} &lt;{ticket.customerEmail}&gt; · opened{" "}
          {formatDateTime(ticket.createdAt)}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <section aria-label="Conversation" className="flex flex-col gap-4">
          {ticket.messages.map((m) => (
            <article
              key={m.id}
              className={cn(
                "rounded-xl border p-4",
                m.authorType === "customer" ? "bg-card" : "bg-muted/50",
              )}
            >
              <header className="mb-2 flex items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2 font-medium">
                  {m.authorType === "customer"
                    ? ticket.customerName
                    : (m.authorName ?? humanize(m.authorType))}
                  {m.sourceDraftId && (
                    <Badge variant="outline" className="text-muted-foreground">
                      AI-assisted, approved by agent
                    </Badge>
                  )}
                </span>
                <time className="text-muted-foreground" dateTime={m.createdAt.toISOString()}>
                  {formatDateTime(m.createdAt)}
                </time>
              </header>
              {/* Plain text only: customer content is never rendered as HTML. */}
              <p className="text-sm whitespace-pre-wrap">{m.body}</p>
              {m.emailStatus && (
                <EmailStatusLine
                  status={m.emailStatus}
                  detail={m.emailDetail}
                  sentAt={m.emailSentAt}
                />
              )}
            </article>
          ))}
          {canWrite && <ReplyForm ticketId={ticket.id} />}
        </section>

        <aside
          aria-label="AI Copilot"
          className="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start"
        >
          <Card>
            <CardHeader>
              <CardTitle>Ticket</CardTitle>
            </CardHeader>
            <CardContent>
              {canWrite ? (
                <TicketControls
                  ticketId={ticket.id}
                  status={ticket.status}
                  assigneeId={ticket.assigneeId}
                  me={user.id}
                  assignees={assignees.map(({ id, name }) => ({ id, name }))}
                />
              ) : (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">Status</dt>
                  <dd className="capitalize">{ticket.status}</dd>
                  <dt className="text-muted-foreground">Assigned to</dt>
                  <dd>{assigneeName ?? "Unassigned"}</dd>
                </dl>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-muted-foreground" aria-hidden />
                <CardTitle>AI triage</CardTitle>
                {ticket.triage && <AiBadge />}
              </div>
              <CardDescription>
                {ticket.triage
                  ? `Generated by ${ticket.triage.model} on ${formatDateTime(ticket.triage.createdAt)}. Check it before relying on it.`
                  : "Not triaged yet. Triage runs in the background after a ticket arrives."}
              </CardDescription>
            </CardHeader>
            {ticket.triage && (
              <CardContent className="flex flex-col gap-4 text-sm">
                <div>
                  <h2 className="mb-1 font-medium">Summary</h2>
                  <p className="whitespace-pre-wrap">{ticket.triage.summary}</p>
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  <dt className="text-muted-foreground">Suggested team</dt>
                  <dd>{humanize(ticket.triage.suggestedTeam)}</dd>
                  <dt className="text-muted-foreground">Routed to</dt>
                  <dd>{ticket.team ? `${humanize(ticket.team)} queue` : "—"}</dd>
                  <dt className="text-muted-foreground">Confidence</dt>
                  <dd>{Math.round(ticket.triage.confidence * 100)}%</dd>
                </dl>
                <div>
                  <h2 className="mb-1 font-medium">Reasoning</h2>
                  <p className="whitespace-pre-wrap text-muted-foreground">
                    {ticket.triage.reasoning}
                  </p>
                </div>
              </CardContent>
            )}
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Draft reply</CardTitle>
              <CardDescription>
                AI drafts a reply from your help articles. Nothing is added to the conversation
                until an agent approves it. Email sending is not built yet.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {draft && (
                <DraftReview
                  key={draft.id}
                  draft={draft}
                  canReview={can(user.role, "draft:review")}
                />
              )}
              {can(user.role, "draft:generate") && (
                <GenerateDraftButton ticketId={ticket.id} hasDraft={Boolean(draft)} aiOn={aiOn} />
              )}
              {!draft && !can(user.role, "draft:generate") && (
                <p className="text-sm text-muted-foreground">No draft yet.</p>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}

const emailStatusView = {
  queued: { icon: Clock, label: "Queued for email", className: "text-muted-foreground" },
  sent: { icon: MailCheck, label: "Emailed to customer", className: "text-muted-foreground" },
  failed: { icon: MailX, label: "Email not delivered", className: "text-destructive" },
  skipped: { icon: MailMinus, label: "Not emailed", className: "text-muted-foreground" },
} as const;

function EmailStatusLine({
  status,
  detail,
  sentAt,
}: {
  status: keyof typeof emailStatusView;
  detail: string | null;
  sentAt: Date | null;
}) {
  const { icon: Icon, label, className } = emailStatusView[status];
  return (
    <p className={cn("mt-3 flex items-center gap-1.5 text-xs", className)}>
      <Icon className="size-3.5" aria-hidden />
      {label}
      {sentAt && ` · ${formatDateTime(sentAt)}`}
      {detail && ` · ${detail}`}
    </p>
  );
}
