import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { DemoBadge, PageHeader, SeverityBadge, StatusBadge } from "@/components/app-ui";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { formatDateTime } from "@/lib/format";
import { can } from "@/server/auth/permissions";
import { requirePagePermission } from "@/server/auth/session";
import { listIncidents } from "@/server/incidents";
import { NewIncidentForm } from "./incident-forms";

export const metadata: Metadata = { title: "Incidents · Support Pilot AI" };

export default function Page() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Incidents"
        description="Operational problems affecting many customers, with the tickets they caused."
      />
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Content />
      </Suspense>
    </div>
  );
}

async function Content() {
  const user = await requirePagePermission("incident:read");
  const items = await listIncidents(getDb(), user.tenantId);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <Card className="py-0">
        <Table>
          <TableCaption className="sr-only">Incidents ({items.length})</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4">Incident</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Open tickets</TableHead>
              <TableHead className="px-4 text-right">Started</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                  No incidents yet.
                </TableCell>
              </TableRow>
            )}
            {items.map((i) => (
              <TableRow key={i.id}>
                <TableCell className="max-w-md px-4">
                  <Link
                    href={`/incidents/${i.id}`}
                    className="block truncate font-medium hover:underline"
                  >
                    {i.title}
                  </Link>
                  {i.isDemo && <DemoBadge />}
                </TableCell>
                <TableCell>
                  <SeverityBadge severity={i.severity} />
                </TableCell>
                <TableCell>
                  <StatusBadge status={i.status} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {i.openTicketCount}
                  <span className="text-muted-foreground"> / {i.ticketCount}</span>
                </TableCell>
                <TableCell className="px-4 text-right text-muted-foreground">
                  <time dateTime={i.startedAt.toISOString()}>{formatDateTime(i.startedAt)}</time>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {can(user.role, "incident:manage") && (
        <Card className="lg:self-start">
          <CardHeader>
            <CardTitle>New incident</CardTitle>
          </CardHeader>
          <CardContent>
            <NewIncidentForm />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
