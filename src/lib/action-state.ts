/** Result shape returned by server actions to `useActionState` forms. Safe to import on the client. */
export interface ActionState {
  status: "idle" | "success" | "error";
  message?: string;
  fieldErrors?: Record<string, string[] | undefined>;
}

export const idleState: ActionState = { status: "idle" };
