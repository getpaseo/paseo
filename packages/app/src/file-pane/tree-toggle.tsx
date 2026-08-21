import { TreeRailToggle } from "@/components/tree-rail-toggle";
import { useCallback } from "react";
import { useIsCompactFormFactor } from "@/constants/layout";
import { defaultFileState, fileStateSchema } from "@/panels/file/state";
import { usePanelState } from "@/panels/use-panel-state";

/**
 * Self-wired so `FilePanelBar` stays a leaf of the file pane tree — the bar is
 * rendered several components below `FilePanel`, which is where the rail lives,
 * and threading a callback down that path buys nothing.
 */
export function FileTreeToggle() {
  const isCompact = useIsCompactFormFactor();
  const [fileState, setFileState] = usePanelState(fileStateSchema, defaultFileState);
  const visible = fileState.treeVisible;
  const toggle = useCallback(
    () => setFileState({ ...fileState, treeVisible: !visible }),
    [fileState, setFileState, visible],
  );
  // Compact layouts reach the tree through the explorer panel; there is no rail
  // beside the file to open or close.
  if (isCompact) {
    return null;
  }
  return <TreeRailToggle visible={visible} testID="file-toggle-tree" onToggle={toggle} />;
}
