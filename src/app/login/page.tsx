import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { getEnv } from "@/env";
import { getCurrentUser } from "@/server/auth/session";
import { GuestSignIn, LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in · Support Pilot AI" };

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col gap-1 text-center">
          <p className="text-sm font-medium text-muted-foreground">Support Pilot AI</p>
          <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
          <p className="text-sm text-muted-foreground">Accounts are created by an administrator.</p>
        </div>
        <Card>
          <CardContent>
            <Suspense fallback={<div className="h-56" aria-busy="true" />}>
              <LoginGate searchParams={searchParams} />
            </Suspense>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

/** Reads the session at request time (inside Suspense, as Cache Components requires). */
async function LoginGate({ searchParams }: Pick<PageProps<"/login">, "searchParams">) {
  if (await getCurrentUser()) redirect("/inbox");
  const { next } = await searchParams;
  const nextPath = typeof next === "string" ? next : undefined;
  return (
    <div className="flex flex-col gap-4">
      <LoginForm next={nextPath} />
      {getEnv().DEMO_USER_PASSWORD && (
        <>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <Separator className="flex-1" />
            or
            <Separator className="flex-1" />
          </div>
          <GuestSignIn next={nextPath} />
        </>
      )}
    </div>
  );
}
