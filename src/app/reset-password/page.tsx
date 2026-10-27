import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { FormMessage } from "@/components/app-ui";
import { Card, CardContent } from "@/components/ui/card";
import { MIN_PASSWORD_LENGTH } from "@/server/auth/constants";
import { ResetPasswordForm } from "./reset-form";

export const metadata: Metadata = {
  title: "Set a new password · Support Pilot AI",
  // The URL carries a reset token: keep it out of the Referer header sent to other sites.
  referrer: "no-referrer",
};

export default function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col gap-1 text-center">
          <p className="text-sm font-medium text-muted-foreground">Support Pilot AI</p>
          <h1 className="text-2xl font-semibold tracking-tight">Set a new password</h1>
          <p className="text-sm text-muted-foreground">
            You&apos;ll be signed out everywhere and can sign in with the new password.
          </p>
        </div>
        <Card>
          <CardContent>
            <Suspense fallback={<div className="h-48" aria-busy="true" />}>
              <Content searchParams={searchParams} />
            </Suspense>
          </CardContent>
        </Card>
        <Link
          href="/forgot-password"
          className="text-center text-sm text-muted-foreground hover:text-foreground"
        >
          Need a new link?
        </Link>
      </div>
    </main>
  );
}

async function Content({ searchParams }: Pick<PageProps<"/reset-password">, "searchParams">) {
  const { token, error } = await searchParams;
  // Better Auth's own link redirects here with ?error=INVALID_TOKEN when the token is bad.
  if (typeof token !== "string" || !token || error) {
    return (
      <FormMessage>This reset link is invalid or has expired. Request a new one below.</FormMessage>
    );
  }
  return <ResetPasswordForm token={token} minLength={MIN_PASSWORD_LENGTH} />;
}
