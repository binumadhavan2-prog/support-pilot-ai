import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { FormMessage } from "@/components/app-ui";
import { Card, CardContent } from "@/components/ui/card";
import { isEmailConfigured } from "@/server/email/mailer";
import { ForgotPasswordForm } from "./forgot-form";

export const metadata: Metadata = { title: "Forgot password · Support Pilot AI" };

export default function ForgotPasswordPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col gap-1 text-center">
          <p className="text-sm font-medium text-muted-foreground">Support Pilot AI</p>
          <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
          <p className="text-sm text-muted-foreground">
            Enter your account email and we&apos;ll send you a link.
          </p>
        </div>
        <Card>
          <CardContent>
            <Suspense fallback={<div className="h-32" aria-busy="true" />}>
              <Content />
            </Suspense>
          </CardContent>
        </Card>
        <Link
          href="/login"
          className="text-center text-sm text-muted-foreground hover:text-foreground"
        >
          Back to sign in
        </Link>
      </div>
    </main>
  );
}

async function Content() {
  // Request time: whether email is configured is runtime config, not build-time.
  await connection();
  if (!isEmailConfigured()) {
    return (
      <FormMessage>
        Password reset by email isn&apos;t set up on this server. Ask an administrator to set a new
        password for you.
      </FormMessage>
    );
  }
  return <ForgotPasswordForm />;
}
