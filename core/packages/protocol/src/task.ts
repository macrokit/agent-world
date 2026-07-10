import type { TaskState } from "./types.js";

export class TransitionError extends Error {}

/**
 * The task state machine (spec 02 §4): every transition is caused by exactly
 * one envelope type. `task.accept` binds the server inside AWARDED and is not
 * a state change; verification reports fan out by outcome.
 */
const TRANSITIONS: Record<string, Array<{ from: TaskState; to: TaskState }>> = {
  "task.award": [{ from: "open", to: "awarded" }],
  "task.deliver": [{ from: "awarded", to: "delivered" }],
  "task.verify:accepted": [{ from: "delivered", to: "settled" }],
  "task.verify:partial": [{ from: "delivered", to: "settled" }],
  "task.verify:rejected": [{ from: "delivered", to: "failed" }],
  "task.cancel": [
    { from: "open", to: "cancelled" },
    { from: "awarded", to: "cancelled" },
  ],
  deadline: [
    { from: "open", to: "expired" },
    { from: "awarded", to: "failed" },
  ],
};

export function transition(state: TaskState, event: string): TaskState {
  const edges = TRANSITIONS[event];
  const edge = edges?.find((e) => e.from === state);
  if (!edge) throw new TransitionError(`no transition for '${event}' from state '${state}'`);
  return edge.to;
}

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "settled",
  "failed",
  "cancelled",
  "expired",
]);
