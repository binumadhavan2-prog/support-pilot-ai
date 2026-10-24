import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DemoBadge, PriorityBadge, SeverityBadge, StatusBadge } from "@/components/app-ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getDb } from "@/db/client";
import { isAppError } from "@/lib/errors";
import { formatDateTime, humanize } from "@/lib/format";
import { can } from "@/server/auth/permissions";
import { requirePagePermission } from "@/server/auth/session";
import { getIncident } from "@/server/incidents";
import { IncidentControls, LinkTicketForm, UnlinkTicketButton } from "../incident-forms";

export const metadata: Metadata = { title: "Incident · Support Pilot AI" };

export default function IncidentPage({ params }: PageProps<"/incidents/[id]">) {
  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/incidents"
        className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Incidents
      </Link>
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Content params={params} />
      </Suspense>
    </div>
  );
}

async function loadIncident(tenantId: string, id: string) {
  try {
    return await getIncident(getDb(), tenantId, id);
  } catch (error) {
    if (isAppError(error) && error.code === "NOT_FOUND") notFound();
    throw error;
  }
}

async function Content({ params }: Pick<PageProps<"/incidents/[id]">, "params">) {
  const user = await requirePagePermission("incident:read");
  const { id } = await params;
  const incident = await loadIncident(user.tenantId, id);
  const canManage = can(user.role, "incident:manage");

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <SeverityBadge severity={incident.severity} />
          <StatusBadge status={incident.status} />
          {incident.isDemo && <DemoBadge />}
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{incident.title}</h1>
        <p className="text-sm text-muted-foreground">
          Started {formatDateTime(incident.startedAt)}
          {incident.resolvedAt && ` · resolved ${formatDateTime(incident.resolvedAt)}`}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm whitespace-pre-wrap">
                {incident.summary ?? <span className="text-muted-foreground">No summary yet.</span>}
              </p>
            </CardContent>
          </Card>

          <Card className="pb-0">
            <CardHeader>
              <CardTitle>Linked tickets ({incident.tickets.length})</CardTitle>
              <CardDescription>Customers affected by this incident.</CardDescription>
            </CardHeader>
            <Table>
              <TableCaption className="sr-only">Linked tickets</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-4">Ticket</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Priority</TableHead>
                  {canManage && (
                    <TableHead className="px-4 text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {incident.tickets.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={canManage ? 4 : 3}
                      className="px-4 py-8 text-center text-muted-foreground"
                    >
                      No tickets linked yet.
                    </TableCell>
                  </TableRow>
                )}
                {incident.tickets.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="max-w-sm px-4">
                      <Link
                        href={`/tickets/${t.id}`}
                        className="block truncate font-medium hover:underline"
                      >
                        {t.subject}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        #{t.number} · {t.customerName}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={t.status} />
                    </TableCell>
                    <TableCell>
                      <PriorityBadge priority={t.priority} />
                    </TableCell>
                    {canManage && (
                      <TableCell className="px-4">
                        <UnlinkTicketButton
                          incidentId={incident.id}
                          ticketId={t.id}
                          label={`ticket #${t.number}`}
                        />
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          {incident.alert && (
            <Card>
              <CardHeader>
                <CardTitle>Monitoring alert</CardTitle>
                <CardDescription>The alert payload that opened this incident.</CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="max-h-80 overflow-auto rounded-lg bg-muted p-3 text-xs">
                  {JSON.stringify(incident.alert, null, 2)}
                </pre>
              </CardContent>
            </Card>
          )}

          {incident.logs && (
            <Card>
              <CardHeader>
                <CardTitle>Logs</CardTitle>
                <CardDescription>Log excerpt attached to the incident.</CardDescription>
              </CardHeader>
              <CardContent>
                {/* Plain text only: log lines are never rendered as HTML. */}
                <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 text-xs">
                  {incident.logs}
                </pre>
              </CardContent>
            </Card>
          )}
        </div>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle>Incident</CardTitle>
            </CardHeader>
            <CardContent>
              {canManage ? (
                <IncidentControls
                  incidentId={incident.id}
                  status={incident.status}
                  severity={incident.severity}
                  summary={incident.summary}
                />
              ) : (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">Status</dt>
                  <dd>{humanize(incident.status)}</dd>
                  <dt className="text-muted-foreground">Severity</dt>
                  <dd>{incident.severity.toUpperCase()}</dd>
                </dl>
              )}
            </CardContent>
          </Card>
          {canManage && (
            <Card>
              <CardContent>
                <LinkTicketForm incidentId={incident.id} />
              </CardContent>
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}
