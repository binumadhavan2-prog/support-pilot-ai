"use client";

import { useActionState } from "react";
import { FieldError, FormMessage } from "@/components/app-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { idleState } from "@/lib/action-state";
import { resetPasswordAction } from "./actions";

export function ResetPasswordForm({ token, minLength }: { token: string; minLength: number }) {
  const [state, formAction, pending] = useActionState(resetPasswordAction, idleState);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.status === "error" && !state.fieldErrors && <FormMessage>{state.message}</FormMessage>}
      <input type="hidden" name="token" value={token} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-password">New password</Label>
        <Input
          id="new-password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={minLength}
          required
          autoFocus
          aria-describedby="new-password-hint new-password-error"
        />
        <p id="new-password-hint" className="text-xs text-muted-foreground">
          At least {minLength} characters.
        </p>
        <FieldError id="new-password-error" messages={state.fieldErrors?.password} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="confirm-password">Confirm new password</Label>
        <Input
          id="confirm-password"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          aria-describedby="confirm-password-error"
        />
        <FieldError id="confirm-password-error" messages={state.fieldErrors?.confirm} />
      </div>
      <Button type="submit" size="lg" disabled={pending} className="w-full">
        {pending ? "Saving…" : "Set new password"}
      </Button>
    </form>
  );
}
