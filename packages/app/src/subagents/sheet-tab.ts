import { useMemo } from "react";
import {
  selectSheetTab,
  useWorkspaceLayoutStore,
  type SheetTab,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { SubagentRow } from "./select";

/** The workspace target a subagent row opens. */
export function subagentRowTarget(row: SubagentRow): WorkspaceTabTarget {
  return row.kind === "provider"
    ? { kind: "provider_subagent", parentAgentId: row.parentAgentId, subagentId: row.id }
    : { kind: "agent", agentId: row.id };
}

/**
 * Answers, per subagent row, the sheet that shows it in place of the list, or null when choosing
 * it reveals a tab instead. `parentTabId` is the tab of the pane the list belongs to.
 */
export function useSubagentSheetTab(
  workspaceKey: string | null,
  parentTabId: string,
): (row: SubagentRow) => SheetTab | null {
  // The rows render the answer, so this subscribes to everything the answer reads. A subagent
  // already open as a tab reveals that tab instead, and a row rendered while that tab existed
  // must re-render once it closes.
  const layoutMode = useWorkspaceLayoutStore((state) => state.layoutMode);
  const layout = useWorkspaceLayoutStore((state) =>
    workspaceKey ? state.layoutByWorkspace[workspaceKey] : undefined,
  );
  const sheets = useWorkspaceLayoutStore((state) =>
    workspaceKey ? state.sheetsByWorkspace[workspaceKey] : undefined,
  );
  return useMemo(() => {
    // One answer per row until the state it reads changes, so a re-render of the list hands an
    // open sheet the same tab rather than a fresh one.
    const answers = new Map<string, SheetTab | null>();
    return (row) => {
      if (!workspaceKey) return null;
      const state = {
        layoutMode,
        layoutByWorkspace: layout ? { [workspaceKey]: layout } : {},
        sheetsByWorkspace: sheets ? { [workspaceKey]: sheets } : {},
      };
      const key = `${row.kind}:${row.id}`;
      const known = answers.get(key);
      if (known !== undefined) return known;
      const sheet = selectSheetTab(state, {
        workspaceKey,
        target: subagentRowTarget(row),
        parentTabId,
      });
      answers.set(key, sheet);
      return sheet;
    };
  }, [layout, layoutMode, parentTabId, sheets, workspaceKey]);
}
