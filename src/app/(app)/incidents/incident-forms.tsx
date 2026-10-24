"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { FieldError, FormMessage } from "@/components/app-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { idleState } from "@/lib/action-state";
import { humanize } from "@/lib/format";
import {
  createIncidentAction,
  linkTicketAction,
  unlinkTicketAction,
  updateIncidentAction,
} from "./actions";

const STATUSES = ["open", "investigating", "mitigated", "resolved"] as const;
const SEVERITIES = ["sev1", "sev2", "sev3", "sev4"] as const;
const SEVERITY_HINT: Record<(typeof SEVERITIES)[number], string> = {
  sev1: "critical, many customers",
  sev2: "major",
  sev3: "minor",
  sev4: "low impact",
};

const textareaClass =
  "w-full rounded-lg border border-input bg-transparent p-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

function SeveritySelect({ id, defaultValue }: { id: string; defaultValue?: string }) {
  return (
    <NativeSelect id={id} name="severity" defaultValue={defaultValue ?? "sev2"} className="w-full">
      {SEVERITIES.map((s) => (
        <NativeSelectOption key={s} value={s}>
          {s.toUpperCase()} ({SEVERITY_HINT[s]})
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

export function NewIncidentForm() {
  const [state, formAction, pending] = useActionState(createIncidentAction, idleState);
  return (
    <form action={formAction} className="flex flex-col gap-3 text-sm">
      {state.status === "error" && <FormMessage>{state.message}</FormMessage>}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-incident-title">Title</Label>
        <Input
          id="new-incident-title"
          name="title"
          required
          maxLength={200}
          placeholder="e.g. Card payments failing at checkout"
          aria-describedby="new-incident-title-error"
        />
        <FieldError id="new-incident-title-error" messages={state.fieldErrors?.title} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-incident-severity">Severity</Label>
        <SeveritySelect id="new-incident-severity" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-incident-summary">Summary (optional)</Label>
        <textarea
          id="new-incident-summary"
          name="summary"
          rows={3}
          maxLength={5000}
          placeholder="What is affected, and what is known so far"
          className={textareaClass}
        />
      </div>
      <Button type="submit" disabled={pending} className="w-fit">
        {pending ? "Creating…" : "Create incident"}
      </Button>
    </form>
  );
}

export function IncidentControls({
  incidentId,
  status,
  severity,
  summary,
}: {
  incidentId: string;
  status: (typeof STATUSES)[number];
  severity: (typeof SEVERITIES)[number];
  summary: string | null;
}) {
  const [state, formAction, pending] = useActionState(updateIncidentAction, idleState);
  // Remount the fields when the server sends new values after a save.
  const key = `${status}-${severity}-${summary ?? ""}`;
  return (
    <form action={formAction} className="flex flex-col gap-3 text-sm">
      <input type="hidden" name="incidentId" value={incidentId} />
      {state.message && (
        <FormMessage tone={state.status === "success" ? "success" : "error"}>
          {state.message}
        </FormMessage>
      )}
      <div key={key} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="incident-status">Status</Label>
          <NativeSelect id="incident-status" name="status" defaultValue={status} className="w-full">
            {STATUSES.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {humanize(s)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="incident-severity">Severity</Label>
          <SeveritySelect id="incident-severity" defaultValue={severity} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="incident-summary">Summary</Label>
          <textarea
            id="incident-summary"
            name="summary"
            rows={4}
            maxLength={5000}
            defaultValue={summary ?? ""}
            className={textareaClass}
          />
        </div>
      </div>
      <Button type="submit" disabled={pending} className="w-fit">
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}

export function LinkTicketForm({ incidentId }: { incidentId: string }) {
  const [state, formAction, pending] = useActionState(linkTicketAction, idleState);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.status === "success") formRef.current?.reset();
  }, [state]);
  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-2 text-sm">
      <input type="hidden" name="incidentId" value={incidentId} />
      <Label htmlFor="link-ticket-number">Link a ticket</Label>
      <div className="flex gap-2">
        <Input
          id="link-ticket-number"
          name="ticketNumber"
          inputMode="numeric"
          required
          placeholder="Ticket number, e.g. 1042"
          aria-describedby="link-ticket-error"
        />
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Linking…" : "Link"}
        </Button>
      </div>
      <FieldError id="link-ticket-error" messages={state.fieldErrors?.ticketNumber} />
      {state.message && !state.fieldErrors && (
        <FormMessage tone={state.status === "success" ? "success" : "error"}>
          {state.message}
        </FormMessage>
      )}
    </form>
  );
}

export function UnlinkTicketButton({
  incidentId,
  ticketId,
  label,
}: {
  incidentId: string;
  ticketId: string;
  label: string;
}) {
  const [state, formAction, pending] = useActionState(unlinkTicketAction, idleState);
  const [confirming, setConfirming] = useState(false);
  return (
    <form action={formAction} className="flex items-center justify-end gap-2">
      <input type="hidden" name="incidentId" value={incidentId} />
      <input type="hidden" name="ticketId" value={ticketId} />
      {state.status === "error" && (
        <span role="alert" className="text-xs text-destructive">
          {state.message}
        </span>
      )}
      {confirming ? (
        <>
          <Button type="submit" size="sm" variant="destructive" disabled={pending}>
            {pending ? "Unlinking…" : "Confirm"}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Unlink ${label}`}
          onClick={() => setConfirming(true)}
        >
          Unlink
        </Button>
      )}
    </form>
  );
}
