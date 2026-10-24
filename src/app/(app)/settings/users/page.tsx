import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader, RoleBadge } from "@/components/app-ui";
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
import { isRole } from "@/server/auth/permissions";
import { requirePagePermission } from "@/server/auth/session";
import { listTenantUsers } from "@/server/tenants";
import { CreateUserForm, UserRowActions } from "./user-forms";

export const metadata: Metadata = { title: "Users · Support Pilot AI" };

export default function UsersPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Users"
        description="Create accounts and manage roles. Self sign-up is disabled."
      />
      <Suspense fallback={<Skeleton className="h-64" />}>
        <UsersContent />
      </Suspense>
    </div>
  );
}

async function UsersContent() {
  const actor = await requirePagePermission("user:manage");
  // Only this tenant's users. (Better Auth's listUsers is tenant-unaware, so it is not used.)
  const users = await listTenantUsers(getDb(), actor.tenantId);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>New user</CardTitle>
        </CardHeader>
        <CardContent>
          <CreateUserForm />
        </CardContent>
      </Card>

      <Card className="py-0">
        <Table>
          <TableCaption className="sr-only">All users ({users.length})</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4">User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="px-4 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => {
              const role = isRole(u.role) ? u.role : "viewer";
              return (
                <TableRow key={u.id}>
                  <TableCell className="px-4">
                    <div className="font-medium">
                      {u.name}
                      {u.id === actor.id && (
                        <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                      )}
                    </div>
                    <div className="text-muted-foreground">{u.email}</div>
                  </TableCell>
                  <TableCell>
                    <RoleBadge role={role} />
                  </TableCell>
                  <TableCell>
                    {u.banned ? (
                      <span className="text-destructive">Banned</span>
                    ) : (
                      <span className="text-emerald-700 dark:text-emerald-400">Active</span>
                    )}
                  </TableCell>
                  <TableCell className="px-4">
                    <UserRowActions
                      userId={u.id}
                      role={role}
                      banned={Boolean(u.banned)}
                      isSelf={u.id === actor.id}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}
