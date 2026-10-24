"use client";

import { useActionState, useEffect, useRef } from "react";
import { FieldError, FormMessage } from "@/components/app-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { idleState } from "@/lib/action-state";
import { MIN_PASSWORD_LENGTH } from "@/server/auth/constants";
import { ROLES, type Role } from "@/server/auth/permissions";
import { createUserAction, setBannedAction, setRoleAction } from "./actions";

export function CreateUserForm() {
  const [state, formAction, pending] = useActionState(createUserAction, idleState);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status === "success") formRef.current?.reset();
  }, [state]);

  const field = (name: string) => ({
    id: `new-${name}`,
    name,
    "aria-invalid": Boolean(state.fieldErrors?.[name]) || undefined,
    "aria-describedby": state.fieldErrors?.[name] ? `new-${name}-error` : undefined,
  });

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-4">
      {state.message && (
        <FormMessage tone={state.status === "success" ? "success" : "error"}>
          {state.message}
        </FormMessage>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-name">Name</Label>
          <Input {...field("name")} autoComplete="off" required />
          <FieldError id="new-name-error" messages={state.fieldErrors?.name} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-email">Email</Label>
          <Input {...field("email")} type="email" autoComplete="off" required />
          <FieldError id="new-email-error" messages={state.fieldErrors?.email} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-password">Initial password</Label>
          <Input
            {...field("password")}
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            required
          />
          <FieldError id="new-password-error" messages={state.fieldErrors?.password} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-role">Role</Label>
          <NativeSelect {...field("role")} defaultValue="viewer" className="w-full">
            {ROLES.map((role) => (
              <NativeSelectOption key={role} value={role}>
                {role}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create user"}
        </Button>
      </div>
    </form>
  );
}

export function UserRowActions({
  userId,
  role,
  banned,
  isSelf,
}: {
  userId: string;
  role: Role;
  banned: boolean;
  isSelf: boolean;
}) {
  const [roleState, roleAction, rolePending] = useActionState(setRoleAction, idleState);
  const [banState, banAction, banPending] = useActionState(setBannedAction, idleState);
  const error = [roleState, banState].find((s) => s.status === "error")?.message;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <form action={roleAction} className="flex items-center gap-2">
          <input type="hidden" name="userId" value={userId} />
          <label htmlFor={`role-${userId}`} className="sr-only">
            Role
          </label>
          <NativeSelect
            id={`role-${userId}`}
            name="role"
            defaultValue={role}
            disabled={isSelf}
            size="sm"
            className="w-28"
          >
            {ROLES.map((r) => (
              <NativeSelectOption key={r} value={r}>
                {r}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button type="submit" variant="outline" size="sm" disabled={isSelf || rolePending}>
            Save
          </Button>
        </form>
        <form action={banAction}>
          <input type="hidden" name="userId" value={userId} />
          <input type="hidden" name="intent" value={banned ? "unban" : "ban"} />
          <Button
            type="submit"
            variant={banned ? "outline" : "destructive"}
            size="sm"
            disabled={isSelf || banPending}
          >
            {banned ? "Unban" : "Ban"}
          </Button>
        </form>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
