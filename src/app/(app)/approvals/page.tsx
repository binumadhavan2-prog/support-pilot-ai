import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AiBadge, PageHeader, PriorityBadge } from "@/components/app-ui";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
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
import { formatAge, formatDateTime } from "@/lib/format";
import { listPendingDrafts } from "@/server/ai/drafts";
import { requirePagePermission } from "@/server/auth/session";

export const metadata: Metadata = { title: "Approvals · Support Pilot AI" };

export default function Page() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Approvals"
        description="AI-drafted replies waiting for review. Nothing is sent to a customer until a person approves it."
      />
      <Suspense fallback={<Skeleton className="h-40" />}>
        <Content />
      </Suspense>
    </div>
  );
}

async function Content() {
  const user = await requirePagePermission("draft:review");
  const drafts = await listPendingDrafts(getDb(), user.tenantId);
  const now = new Date();

  return (
    <Card className="py-0">
      <Table>
        <TableCaption className="sr-only">Drafts waiting for review ({drafts.length})</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead className="px-4">Ticket</TableHead>
            <TableHead>Priority</TableHead>
            <TableHead>Draft</TableHead>
            <TableHead>Requested by</TableHead>
            <TableHead className="px-4 text-right">Waiting</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {drafts.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                No drafts waiting. Open a ticket and choose &quot;Draft a reply&quot;.
              </TableCell>
            </TableRow>
          )}
          {drafts.map((d) => (
            <TableRow key={d.draftId}>
              <TableCell className="max-w-md px-4">
                <Link
                  href={`/tickets/${d.ticketId}`}
                  className="block truncate font-medium hover:underline"
                >
                  {d.subject}
                </Link>
                <div className="text-xs text-muted-foreground">
                  #{d.number} · {d.customerName}
                </div>
              </TableCell>
              <TableCell>
                <PriorityBadge priority={d.priority} />
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  <AiBadge />
                  {d.groundingStatus === "grounded" ? (
                    <Badge variant="secondary">From help articles</Badge>
                  ) : (
                    <Badge variant="outline">Holding reply</Badge>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground">{d.requestedBy ?? "—"}</TableCell>
              <TableCell className="px-4 text-right text-muted-foreground tabular-nums">
                <time dateTime={d.createdAt.toISOString()} title={formatDateTime(d.createdAt)}>
                  {formatAge(d.createdAt, now)}
                </time>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
