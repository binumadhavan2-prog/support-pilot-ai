/** Result of the ask form. Safe to import on the client (no server code). */
export interface AskSource {
  n: number;
  documentTitle: string;
  kind: "article" | "runbook";
  content: string;
  score: number;
}

export type AskState =
  | { status: "idle" }
  | { status: "error"; message: string; question?: string }
  | {
      status: "done";
      question: string;
      mode: "ai" | "search_only";
      grounded: boolean;
      answer: string | null;
      model: string | null;
      sources: AskSource[];
    };

export const idleAskState: AskState = { status: "idle" };
