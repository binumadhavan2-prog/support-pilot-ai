"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { FormMessage } from "@/components/app-ui";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { idleState } from "@/lib/action-state";
import { humanize } from "@/lib/format";
import { replyAction, updateTicketAction } from "./actions";

const STATUSES = ["open", "pending", "resolved", "closed"] as const;
const STATUS_HINT: Record<(typeof STATUSES)[number], string> = {
  open: "needs a reply",
  pending: "waiting on the customer",
  resolved: "fixed, may reopen",
  closed: "done",
};

export function TicketControls({
  ticketId,
  status,
  assigneeId,
  me,
  assignees,
}: {
  ticketId: string;
  status: (typeof STATUSES)[number];
  assigneeId: string | null;
  me: string;
  assignees: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState(updateTicketAction, idleState);
  const formRef = useRef<HTMLFormElement>(null);
  // Controlled, and synced when the server sends new values after a save. (Remounting the form
  // instead would also wipe the "Saved." message the moment it appears.)
  const [statusValue, setStatusValue] = useState<string>(status);
  const [assigneeValue, setAssigneeValue] = useState(assigneeId ?? "");
  const [synced, setSynced] = useState({ status, assigneeId });
  if (synced.status !== status || synced.assigneeId !== assigneeId) {
    setSynced({ status, assigneeId });
    setStatusValue(status);
    setAssigneeValue(assigneeId ?? "");
  }

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-3 text-sm">
      <input type="hidden" name="ticketId" value={ticketId} />
      {state.message && (
        <FormMessage tone={state.status === "success" ? "success" : "error"}>
          {state.message}
        </FormMessage>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ticket-status">Status</Label>
        <NativeSelect
          id="ticket-status"
          name="status"
          value={statusValue}
          onChange={(e) => setStatusValue(e.target.value)}
          className="w-full"
        >
          {STATUSES.map((s) => (
            <NativeSelectOption key={s} value={s}>
              {humanize(s)} ({STATUS_HINT[s]})
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ticket-assignee">Assigned to</Label>
        <NativeSelect
          id="ticket-assignee"
          name="assigneeId"
          value={assigneeValue}
          onChange={(e) => setAssigneeValue(e.target.value)}
          className="w-full"
        >
          <NativeSelectOption value="">Unassigned</NativeSelectOption>
          {assignees.map((a) => (
            <NativeSelectOption key={a.id} value={a.id}>
              {a.name}
              {a.id === me ? " (me)" : ""}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {assigneeId !== me && assignees.some((a) => a.id === me) && (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => {
              // Render the new value before submitting, so the form sends it.
              flushSync(() => setAssigneeValue(me));
              formRef.current?.requestSubmit();
            }}
          >
            Assign to me
          </Button>
        )}
      </div>
    </form>
  );
}

export function ReplyForm({ ticketId }: { ticketId: string }) {
  const [state, formAction, pending] = useActionState(replyAction, idleState);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status === "success") formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-2 rounded-xl border p-4">
      <input type="hidden" name="ticketId" value={ticketId} />
      <Label htmlFor="reply-body">Reply or internal note</Label>
      <textarea
        id="reply-body"
        name="body"
        rows={5}
        maxLength={50_000}
        required
        placeholder="Write a reply to the customer, or a note for your team…"
        className="w-full rounded-lg border border-input bg-transparent p-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
      />
      {state.message && (
        <FormMessage tone={state.status === "success" ? "success" : "error"}>
          {state.message}
        </FormMessage>
      )}
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Replies are emailed to the customer when email is set up. Notes stay inside the team.
        </p>
        <div className="flex shrink-0 gap-2">
          <Button type="submit" name="kind" value="note" variant="outline" disabled={pending}>
            Add internal note
          </Button>
          <Button type="submit" name="kind" value="reply" disabled={pending}>
            {pending ? "Adding…" : "Add reply"}
          </Button>
        </div>
      </div>
    </form>
  );
}
