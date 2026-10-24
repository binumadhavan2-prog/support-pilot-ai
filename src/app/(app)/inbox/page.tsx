import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import {
  DemoBadge,
  PRIORITY_LABEL,
  PageHeader,
  PriorityBadge,
  StatusBadge,
} from "@/components/app-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
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
import { formatAge, formatDateTime, humanize } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/session";
import {
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  listTickets,
  listTicketsQuerySchema,
  searchParamsToObject,
  type ListTicketsQuery,
} from "@/server/tickets";

export const metadata: Metadata = { title: "Inbox · Support Pilot AI" };

export default function Page({ searchParams }: PageProps<"/inbox">) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Inbox" description="Customer tickets waiting for a response." />
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Content({ searchParams }: Pick<PageProps<"/inbox">, "searchParams">) {
  const user = await requirePagePermission("ticket:read");
  // Invalid filter values (a hand-edited URL) fall back to "no filter" rather than an error page.
  const parsed = listTicketsQuerySchema.safeParse(searchParamsToObject(await searchParams));
  const query = parsed.success ? parsed.data : listTicketsQuerySchema.parse({});
  const result = await listTickets(getDb(), user.tenantId, query, { viewerId: user.id });
  const now = new Date();
  const filtered = Boolean(
    query.status || query.priority || query.category || query.search || query.assignee,
  );

  return (
    <>
      <Filters query={query} />

      <Card className="py-0">
        <Table>
          <TableCaption className="sr-only">Tickets ({result.total})</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4">Subject</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Assigned</TableHead>
              <TableHead className="px-4 text-right">Age</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                  {filtered ? "No tickets match these filters." : "No tickets yet."}
                </TableCell>
              </TableRow>
            )}
            {result.items.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="max-w-md px-4">
                  <Link
                    href={`/tickets/${t.id}`}
                    className="block truncate font-medium hover:underline"
                  >
                    {t.subject}
                  </Link>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    #{t.number}
                    {t.isDemo && <DemoBadge />}
                    {t.injectionFlagged && (
                      <Badge variant="destructive" title="AI flagged a prompt-injection attempt">
                        <ShieldAlert aria-hidden />
                        Injection
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <div>{t.customerName}</div>
                  <div className="text-xs text-muted-foreground">{t.customerEmail}</div>
                </TableCell>
                <TableCell>
                  <StatusBadge status={t.status} />
                </TableCell>
                <TableCell>
                  <PriorityBadge priority={t.priority} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <div>{t.category ? humanize(t.category) : "Untriaged"}</div>
                  {t.team && <div className="text-xs">→ {humanize(t.team)} queue</div>}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {t.assigneeId === user.id ? "Me" : (t.assigneeName ?? "—")}
                </TableCell>
                <TableCell className="px-4 text-right text-muted-foreground tabular-nums">
                  <time dateTime={t.createdAt.toISOString()} title={formatDateTime(t.createdAt)}>
                    {formatAge(t.createdAt, now)}
                  </time>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Pagination query={query} total={result.total} totalPages={result.totalPages} />
    </>
  );
}

/** A plain GET form: filters live in the URL, so views are shareable and work without JS. */
function Filters({ query }: { query: ListTicketsQuery }) {
  const selects = [
    { name: "status", label: "Status", values: TICKET_STATUSES, value: query.status },
    { name: "priority", label: "Priority", values: TICKET_PRIORITIES, value: query.priority },
    { name: "category", label: "Category", values: TICKET_CATEGORIES, value: query.category },
  ];
  const optionLabel = (name: string, v: string) =>
    name === "priority"
      ? `${PRIORITY_LABEL[v as keyof typeof PRIORITY_LABEL]} · ${humanize(v)}`
      : humanize(v);
  return (
    <form method="get" className="flex flex-wrap items-end gap-3" role="search">
      <div className="flex min-w-56 flex-1 flex-col gap-1.5">
        <Label htmlFor="search">Search</Label>
        <Input
          id="search"
          name="search"
          type="search"
          placeholder="Subject, customer, email or #number"
          defaultValue={query.search}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="assignee">Assigned</Label>
        <NativeSelect id="assignee" name="assignee" defaultValue={query.assignee ?? ""}>
          <NativeSelectOption value="">Anyone</NativeSelectOption>
          <NativeSelectOption value="me">Me</NativeSelectOption>
          <NativeSelectOption value="unassigned">Unassigned</NativeSelectOption>
        </NativeSelect>
      </div>
      {selects.map((s) => (
        <div key={s.name} className="flex flex-col gap-1.5">
          <Label htmlFor={s.name}>{s.label}</Label>
          <NativeSelect id={s.name} name={s.name} defaultValue={s.value ?? ""}>
            <NativeSelectOption value="">Any</NativeSelectOption>
            {s.values.map((v) => (
              <NativeSelectOption key={v} value={v}>
                {optionLabel(s.name, v)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      ))}
      <Button type="submit">Apply</Button>
      <Button variant="ghost" asChild>
        <Link href="/inbox">Reset</Link>
      </Button>
    </form>
  );
}

function Pagination({
  query,
  total,
  totalPages,
}: {
  query: ListTicketsQuery;
  total: number;
  totalPages: number;
}) {
  const hrefFor = (page: number) => {
    const params = new URLSearchParams();
    for (const key of ["search", "assignee", "status", "priority", "category"] as const) {
      const value = query[key];
      if (value) params.set(key, value);
    }
    if (page > 1) params.set("page", String(page));
    const qs = params.toString();
    return qs ? `/inbox?${qs}` : "/inbox";
  };
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-4 text-sm">
      <p className="text-muted-foreground">
        {total} {total === 1 ? "ticket" : "tickets"} · page {Math.min(query.page, totalPages)} of{" "}
        {totalPages}
      </p>
      <div className="flex gap-2">
        {query.page > 1 ? (
          <Button variant="outline" size="sm" asChild>
            <Link href={hrefFor(Math.min(query.page - 1, totalPages))}>Previous</Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            Previous
          </Button>
        )}
        {query.page < totalPages ? (
          <Button variant="outline" size="sm" asChild>
            <Link href={hrefFor(query.page + 1)}>Next</Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            Next
          </Button>
        )}
      </div>
    </nav>
  );
}
