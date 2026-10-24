import { Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader, RoleBadge } from "@/components/app-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { can, permissionsFor } from "@/server/auth/permissions";
import { requirePageUser } from "@/server/auth/session";

export const metadata: Metadata = { title: "Settings · Support Pilot AI" };

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Settings" description="Your account and workspace administration." />
      <Suspense fallback={<Skeleton className="h-48" />}>
        <SettingsContent />
      </Suspense>
    </div>
  );
}

async function SettingsContent() {
  // Every signed-in role may see its own account; admin sections are gated below and on their pages.
  const user = await requirePageUser();

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Signed in as</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-lg font-medium">{user.name}</p>
          <p className="text-sm text-muted-foreground">{user.email}</p>
          <div>
            <RoleBadge role={user.role} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your permissions</CardTitle>
          <CardDescription>Granted by the {user.role} role.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-wrap gap-1.5">
            {permissionsFor(user.role).map((permission) => (
              <li key={permission} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                {permission}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {can(user.role, "user:manage") && (
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Users</CardTitle>
            <CardDescription>Create accounts, change roles and ban or unban users.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/settings/users">
                <Users />
                Manage users
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
