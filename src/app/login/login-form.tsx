"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/app-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { idleState } from "@/lib/action-state";
import { signInAction, signInAsGuestAction } from "./actions";

export function LoginForm({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState(signInAction, idleState);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.status === "error" && state.message && <FormMessage>{state.message}</FormMessage>}
      {next && <input type="hidden" name="next" value={next} />}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>

      <Button type="submit" size="lg" disabled={pending} className="mt-2 w-full">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

/** DEMO: one-click sign-in as the read-only demo viewer. Rendered only when guest access is on. */
export function GuestSignIn({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState(signInAsGuestAction, idleState);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {state.status === "error" && state.message && <FormMessage>{state.message}</FormMessage>}
      {next && <input type="hidden" name="next" value={next} />}
      <Button type="submit" variant="outline" size="lg" disabled={pending} className="w-full">
        {pending ? "Signing in…" : "Try as Guest"}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        Read-only demo account with generated demo data.
      </p>
    </form>
  );
}
