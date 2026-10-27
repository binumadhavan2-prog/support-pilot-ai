"use client";

import { useActionState } from "react";
import { FieldError, FormMessage } from "@/components/app-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { idleState } from "@/lib/action-state";
import { forgotPasswordAction } from "./actions";

export function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState(forgotPasswordAction, idleState);

  if (state.status === "success") {
    return <FormMessage tone="success">{state.message}</FormMessage>;
  }
  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.status === "error" && !state.fieldErrors && <FormMessage>{state.message}</FormMessage>}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="forgot-email">Email</Label>
        <Input
          id="forgot-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          aria-describedby="forgot-email-error"
        />
        <FieldError id="forgot-email-error" messages={state.fieldErrors?.email} />
      </div>
      <Button type="submit" size="lg" disabled={pending} className="w-full">
        {pending ? "Sending…" : "Send reset link"}
      </Button>
    </form>
  );
}
