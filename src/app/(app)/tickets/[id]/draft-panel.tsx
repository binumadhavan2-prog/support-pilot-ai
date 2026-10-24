"use client";

import { FileText, ShieldAlert, Sparkles } from "lucide-react";
import { useActionState, useState } from "react";
import { AiBadge, FormMessage } from "@/components/app-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { idleState } from "@/lib/action-state";
import { generateDraftAction, reviewDraftAction } from "./actions";

export interface DraftView {
  id: string;
  body: string;
  status: "pending" | "approved" | "edited" | "rejected";
  grounded: boolean;
  model: string;
  rejectReason: string | null;
  createdAt: string;
  sources: { position: number; documentTitle: string; quote: string; score: number }[];
}

export function GenerateDraftButton({
  ticketId,
  hasDraft,
  aiOn,
}: {
  ticketId: string;
  hasDraft: boolean;
  aiOn: boolean;
}) {
  const [state, formAction, pending] = useActionState(generateDraftAction, idleState);
  if (!aiOn) {
    return (
      <p className="text-sm text-muted-foreground">
        AI drafting is off until a Claude API key is set.
      </p>
    );
  }
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="ticketId" value={ticketId} />
      {state.message && (
        <FormMessage tone={state.status === "success" ? "success" : "error"}>
          {state.message}
        </FormMessage>
      )}
      <Button type="submit" variant={hasDraft ? "outline" : "default"} disabled={pending}>
        <Sparkles aria-hidden />
        {pending ? "Drafting… (can take ~30 s)" : hasDraft ? "Draft again" : "Draft a reply"}
      </Button>
    </form>
  );
}

export function DraftReview({ draft, canReview }: { draft: DraftView; canReview: boolean }) {
  const [state, formAction, pending] = useActionState(reviewDraftAction, idleState);
  const [body, setBody] = useState(draft.body);
  const [rejecting, setRejecting] = useState(false);
  const reviewed = draft.status !== "pending";

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <AiBadge />
        {draft.grounded ? (
          <Badge variant="secondary">From {draft.sources.length} help article section(s)</Badge>
        ) : (
          <Badge variant="secondary" className="gap-1">
            <ShieldAlert aria-hidden />
            Not covered by help articles
          </Badge>
        )}
        {reviewed && (
          <Badge variant="outline" className="capitalize">
            {draft.status === "edited" ? "Edited and approved" : draft.status}
          </Badge>
        )}
      </div>

      {state.message && (
        <FormMessage tone={state.status === "success" ? "success" : "error"}>
          {state.message}
        </FormMessage>
      )}

      {reviewed || !canReview ? (
        <>
          <p className="rounded-lg border bg-muted/30 p-3 whitespace-pre-wrap">{draft.body}</p>
          {draft.status === "rejected" && draft.rejectReason && (
            <p className="text-muted-foreground">Reason: {draft.rejectReason}</p>
          )}
          {!reviewed && !canReview && (
            <p className="text-muted-foreground">Waiting for an agent to review.</p>
          )}
        </>
      ) : (
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="draftId" value={draft.id} />
          <Label htmlFor="draft-body" className="sr-only">
            Draft reply
          </Label>
          <textarea
            id="draft-body"
            name="body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={12}
            className="w-full rounded-lg border border-input bg-transparent p-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          />
          <p className="text-xs text-muted-foreground">
            [n] markers point to the sources below and are removed when approved. Your name is added
            after &quot;Best regards,&quot;.
          </p>
          {rejecting ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="reject-reason">Why reject? (optional)</Label>
              <Input id="reject-reason" name="reason" maxLength={500} />
              <div className="flex gap-2">
                <Button
                  type="submit"
                  name="decision"
                  value="reject"
                  variant="destructive"
                  disabled={pending}
                >
                  Reject draft
                </Button>
                <Button type="button" variant="ghost" onClick={() => setRejecting(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                name="decision"
                value="approve"
                disabled={pending || !body.trim()}
              >
                {pending
                  ? "Saving…"
                  : body !== draft.body
                    ? "Approve edited reply"
                    : "Approve reply"}
              </Button>
              <Button type="button" variant="outline" onClick={() => setRejecting(true)}>
                Reject
              </Button>
            </div>
          )}
        </form>
      )}

      {draft.sources.length > 0 && (
        <details className="rounded-lg border p-3">
          <summary className="cursor-pointer font-medium">Sources ({draft.sources.length})</summary>
          <ol className="mt-2 flex flex-col gap-2">
            {draft.sources.map((s) => (
              <li key={s.position} className="text-muted-foreground">
                <div className="flex items-center gap-1 font-medium text-foreground">
                  <FileText className="size-3.5" aria-hidden />[{s.position}] {s.documentTitle}
                </div>
                <p className="line-clamp-4 whitespace-pre-wrap">{s.quote}</p>
              </li>
            ))}
          </ol>
        </details>
      )}
      <p className="text-xs text-muted-foreground">
        Drafted by {draft.model === "none" ? "a fixed template (no AI call)" : draft.model}.
      </p>
    </div>
  );
}
