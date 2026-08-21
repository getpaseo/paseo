import type { OrchestrationGroup } from "./orchestration-group-store.js";

/** The only completion payload suitable for a parent context: bounded summaries and pointers. */
export function renderOrchestrationResult(group: OrchestrationGroup): string {
  const children = group.expectedChildIds.map((agentId) => {
    const child = group.children[agentId]!;
    return {
      agentId,
      terminalState: child.terminalState,
      summary: child.summary,
      resultPointer: child.resultPointer,
    };
  });
  return JSON.stringify({ groupId: group.id, state: group.state, children });
}
