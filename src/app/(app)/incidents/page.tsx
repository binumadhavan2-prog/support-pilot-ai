import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-ui";
import { NotBuiltYet } from "@/components/not-built-yet";
import { Skeleton } from "@/components/ui/skeleton";
import { requirePagePermission } from "@/server/auth/session";

export const metadata: Metadata = { title: "Incidents · Support Pilot AI" };

export default function Page() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Incidents"
        description="Spikes of related tickets that need coordinated handling."
      />
      <Suspense fallback={<Skeleton className="h-40" />}>
        <Content />
      </Suspense>
    </div>
  );
}

async function Content() {
  await requirePagePermission("ticket:read");
  return (
    <NotBuiltYet
      phase="Planned"
      summary="Grouping related tickets into incidents. Not yet scheduled in the roadmap."
    />
  );
}
