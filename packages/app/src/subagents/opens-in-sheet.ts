import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { SubagentRow } from "./select";

/** The workspace target a subagent row opens. */
export function subagentRowTarget(row: SubagentRow): WorkspaceTabTarget {
  return row.kind === "provider"
    ? { kind: "provider_subagent", parentAgentId: row.parentAgentId, subagentId: row.id }
    : { kind: "agent", agentId: row.id };
}

/** Answers, per subagent row, whether opening it in this workspace shows a sheet rather than a tab. */
export function useSubagentOpensInSheet(
  workspaceKey: string | null,
): (row: SubagentRow) => boolean {
  // The rows render the answer, so this subscribes to what the answer reads: the layout mode and
  // the workspace's tabs. A subagent already open as a tab reveals that tab instead of a sheet,
  // and a row rendered while that tab existed must re-render once it closes, or choosing the row
  // would still close the list it sits in.
  useWorkspaceLayoutStore((state) => state.layoutMode);
  useWorkspaceLayoutStore((state) =>
    workspaceKey ? state.layoutByWorkspace[workspaceKey] : undefined,
  );
  return (row) =>
    workspaceKey !== null &&
    useWorkspaceLayoutStore
      .getState()
      .opensInSheet({ workspaceKey, target: subagentRowTarget(row), intent: "reveal" });
}
