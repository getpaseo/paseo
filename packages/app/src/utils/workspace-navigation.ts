import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  prepareWorkspaceTab as prepareWorkspaceTabPure,
  type PrepareWorkspaceTabInput,
} from "./prepare-workspace-tab";

export type { PrepareWorkspaceTabInput } from "./prepare-workspace-tab";

function layoutStoreDeps() {
  const store = useWorkspaceLayoutStore.getState();
  return {
    openTabFocused: store.openTabFocused,
    pinAgent: store.pinAgent,
  };
}

export function prepareWorkspaceTab(input: PrepareWorkspaceTabInput): void {
  prepareWorkspaceTabPure(input, layoutStoreDeps());
}
