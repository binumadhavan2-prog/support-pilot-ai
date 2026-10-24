import type { Metadata } from "next";
import { Suspense } from "react";
import { DemoBadge, PageHeader } from "@/components/app-ui";
import { Badge } from "@/components/ui/badge";
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
import { getEnv } from "@/env";
import { formatDateTime } from "@/lib/format";
import { can } from "@/server/auth/permissions";
import { requirePagePermission } from "@/server/auth/session";
import { MAX_DOCUMENT_BYTES, listDocuments } from "@/server/knowledge/documents";
import { AskForm, DocumentRowActions, UploadForm } from "./knowledge-forms";

export const metadata: Metadata = { title: "Knowledge Base · Support Pilot AI" };

export default function Page() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Knowledge Base"
        description="Ask questions answered from your company's documents, with sources."
      />
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Content />
      </Suspense>
    </div>
  );
}

async function Content() {
  const user = await requirePagePermission("document:read");
  const docs = await listDocuments(getDb(), user.tenantId);
  const canManage = can(user.role, "document:manage");
  const aiOn = Boolean(getEnv().ANTHROPIC_API_KEY);

  return (
    <>
      {can(user.role, "kb:ask") && (
        <Card>
          <CardHeader>
            <CardTitle>Ask the knowledge base</CardTitle>
            <CardDescription>
              {aiOn
                ? "Answers come only from the documents below and cite them. If the documents don't cover it, the answer says so."
                : "AI answers are off until a Claude API key is set. You'll get the most relevant sections instead."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {docs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No documents yet.{" "}
                {canManage ? "Upload one below to start." : "Ask an admin to upload some."}
              </p>
            ) : (
              <AskForm />
            )}
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>Add a document</CardTitle>
            <CardDescription>
              Help articles can be quoted to customers; runbooks are internal procedures for staff.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <UploadForm maxMb={MAX_DOCUMENT_BYTES / (1024 * 1024)} />
          </CardContent>
        </Card>
      )}

      <Card className="py-0">
        <Table>
          <TableCaption className="sr-only">Documents ({docs.length})</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4">Document</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Sections</TableHead>
              <TableHead>Search</TableHead>
              <TableHead>Added</TableHead>
              {canManage && (
                <TableHead className="px-4 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {docs.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={canManage ? 6 : 5}
                  className="px-4 py-10 text-center text-muted-foreground"
                >
                  No documents yet.
                </TableCell>
              </TableRow>
            )}
            {docs.map((d) => (
              <TableRow key={d.id}>
                <TableCell className="max-w-md px-4">
                  <div className="truncate font-medium">{d.title}</div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {d.filename}
                    {d.isDemo && <DemoBadge />}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={d.kind === "runbook" ? "outline" : "secondary"}>
                    {d.kind === "runbook" ? "Internal runbook" : "Help article"}
                  </Badge>
                </TableCell>
                <TableCell className="tabular-nums">{d.chunkCount}</TableCell>
                <TableCell>
                  {d.errorMessage ? (
                    <span className="text-xs text-muted-foreground" title={d.errorMessage}>
                      Keyword only
                    </span>
                  ) : (
                    <span className="text-xs">Keyword + meaning</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDateTime(d.createdAt)}
                </TableCell>
                {canManage && (
                  <TableCell className="px-4">
                    <DocumentRowActions
                      documentId={d.id}
                      title={d.title}
                      canReindex={Boolean(d.errorMessage)}
                    />
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}
