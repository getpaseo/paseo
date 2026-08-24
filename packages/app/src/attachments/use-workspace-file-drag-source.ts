import type { RefCallback } from "react";
import type { View } from "react-native";
import type { WorkspaceFileDragSourceInput } from "./workspace-file-drag-source.types";

export function useWorkspaceFileDragSource(
  _input: WorkspaceFileDragSourceInput,
): RefCallback<View> | undefined {
  return undefined;
}
