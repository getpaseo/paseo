import type { StepIR, TransitionTargetIR, WorkflowValidationIssue } from "../ir.js";

/**
 * Validate transition targets and bounded-cycle safety:
 * 1. Every `{ next }` target must refer to an existing state.
 * 2. Every cycle in the state graph must contain at least one state that sets
 *    `maxLoops >= 1` AND declares `on.max_loops_exceeded`.
 *    (Graph-theoretically equivalent to: removing all loop-guarded states yields a DAG.)
 * 3. A loop-guarded state's `max_loops_exceeded` transition cannot target itself.
 */
export function validateStateGraph(
  states: Readonly<Record<string, StepIR>>,
): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  const stateIds = new Set(Object.keys(states));

  for (const [stateId, step] of Object.entries(states)) {
    for (const [outcome, target] of Object.entries(step.on)) {
      if ("next" in target && !stateIds.has(target.next)) {
        issues.push({
          path: `states.${stateId}.on.${outcome}`,
          message: `transition target "${target.next}" does not exist in states`,
        });
      }
    }

    const exceededTarget = step.on["max_loops_exceeded"];
    if (
      exceededTarget !== undefined &&
      "next" in exceededTarget &&
      exceededTarget.next === stateId
    ) {
      issues.push({
        path: `states.${stateId}.on.max_loops_exceeded`,
        message: `max_loops_exceeded transition on "${stateId}" cannot target itself`,
      });
    }
  }

  // States that guard any cycle passing through them.
  const guarded = new Set<string>();
  for (const [stateId, step] of Object.entries(states)) {
    if (
      step.maxLoops !== undefined &&
      step.maxLoops >= 1 &&
      step.on["max_loops_exceeded"] !== undefined
    ) {
      guarded.add(stateId);
    }
  }

  // Check whether the subgraph induced by unguarded states contains any cycle.
  const unguardedCycle = findCycle(states, stateIds, (id) => !guarded.has(id));
  if (unguardedCycle !== undefined) {
    issues.push({
      path: `states.${unguardedCycle[0]}`,
      message:
        `unguarded cycle detected (${unguardedCycle.join(" -> ")}): ` +
        "at least one state in every cycle must declare both maxLoops and on.max_loops_exceeded",
    });
  }

  return issues;
}

export type TransitionResolution =
  | { readonly kind: "next"; readonly stateId: string }
  | {
      readonly kind: "terminal";
      readonly target: Extract<TransitionTargetIR, { readonly terminal: string }>;
    }
  | { readonly kind: "unhandled"; readonly outcome: string };

/**
 * Pure transition resolver: given a completed step's outcome, look up `on[outcome] ?? on["*"]`.
 * If the target state would exceed its `maxLoops` budget, route through `target.on.max_loops_exceeded`.
 */
export function resolveTransition(
  states: Readonly<Record<string, StepIR>>,
  currentStateId: string,
  outcome: string,
  loopCounts: Readonly<Record<string, number>>,
): TransitionResolution {
  const currentStep = states[currentStateId];
  if (currentStep === undefined) {
    return { kind: "unhandled", outcome };
  }

  const target = currentStep.on[outcome] ?? currentStep.on["*"];
  if (target === undefined) {
    return { kind: "unhandled", outcome };
  }

  return followTarget(states, target, loopCounts, new Set());
}

function followTarget(
  states: Readonly<Record<string, StepIR>>,
  target: TransitionTargetIR,
  loopCounts: Readonly<Record<string, number>>,
  visited: Set<string>,
): TransitionResolution {
  if ("terminal" in target) {
    return { kind: "terminal", target };
  }
  const nextStep = states[target.next];
  if (nextStep === undefined) {
    return { kind: "unhandled", outcome: target.next };
  }

  const executedCount = loopCounts[nextStep.id] ?? 0;
  if (nextStep.maxLoops !== undefined && executedCount >= nextStep.maxLoops) {
    const exceededTarget = nextStep.on["max_loops_exceeded"];
    if (exceededTarget === undefined || visited.has(nextStep.id)) {
      return { kind: "unhandled", outcome: "max_loops_exceeded" };
    }
    visited.add(nextStep.id);
    return followTarget(states, exceededTarget, loopCounts, visited);
  }

  return { kind: "next", stateId: nextStep.id };
}

function findCycle(
  states: Readonly<Record<string, StepIR>>,
  stateIds: ReadonlySet<string>,
  include: (stateId: string) => boolean,
): string[] | undefined {
  // 0 = unvisited, 1 = visiting (on stack), 2 = visited
  const color = new Map<string, number>();
  const stack: string[] = [];

  const dfs = (nodeId: string): string[] | undefined => {
    color.set(nodeId, 1);
    stack.push(nodeId);

    const step = states[nodeId];
    if (step !== undefined) {
      for (const target of Object.values(step.on)) {
        if (!("next" in target)) {
          continue;
        }
        const nextId = target.next;
        if (!stateIds.has(nextId) || !include(nextId)) {
          continue;
        }
        const nextColor = color.get(nextId) ?? 0;
        if (nextColor === 1) {
          const cycleStart = stack.indexOf(nextId);
          return [...stack.slice(cycleStart), nextId];
        }
        if (nextColor === 0) {
          const found = dfs(nextId);
          if (found !== undefined) {
            return found;
          }
        }
      }
    }

    stack.pop();
    color.set(nodeId, 2);
    return undefined;
  };

  for (const stateId of Object.keys(states)) {
    if (!include(stateId)) {
      continue;
    }
    if ((color.get(stateId) ?? 0) === 0) {
      const found = dfs(stateId);
      if (found !== undefined) {
        return found;
      }
    }
  }

  return undefined;
}
