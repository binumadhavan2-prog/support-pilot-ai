"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/app-ui";
import { Button } from "@/components/ui/button";
import { idleState } from "@/lib/action-state";
import { sendVerificationAction } from "./actions";

export function SendVerificationButton() {
  const [state, formAction, pending] = useActionState(sendVerificationAction, idleState);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      {state.message && (
        <FormMessage tone={state.status === "success" ? "success" : "error"}>
          {state.message}
        </FormMessage>
      )}
      <Button type="submit" variant="outline" size="sm" disabled={pending} className="w-fit">
        {pending ? "Sending…" : "Send verification email"}
      </Button>
    </form>
  );
}
