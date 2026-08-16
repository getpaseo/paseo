import type { CommandRuntimeState } from "../src/index.js";

interface ExpectedState {
  workspaceId: string;
  lifecycle: "ready" | "paused";
  lifecycleEnvironment?: Record<string, string>;
}

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
const exactStateShape: Equal<CommandRuntimeState, ExpectedState> = true;
void exactStateShape;

declare const state: CommandRuntimeState;
declare const inspection: { state: CommandRuntimeState };
const rootKey = ["ro", "ot"].join("");
// @ts-expect-error Physical placement is not part of public runtime state.
void state.root;
// @ts-expect-error Constant aliases cannot recover private placement.
void state["root" as const];
// @ts-expect-error Computed string access has no public state index signature.
void state[rootKey];
// @ts-expect-error Chained bracket access cannot cross the public state boundary.
void inspection["state"]["root"];
