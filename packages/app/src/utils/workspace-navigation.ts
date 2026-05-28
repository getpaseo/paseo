import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  prepareWorkspaceTab as prepareWorkspaceTabPure,
  navigateToPreparedWorkspaceTab as navigateToPreparedWorkspaceTabPure,
  type PrepareWorkspaceTabInput,
  type NavigateToPreparedWorkspaceTabInput,
} from "./prepare-workspace-tab";

export type {
  PrepareWorkspaceTabInput,
  NavigateToPreparedWorkspaceTabInput,
} from "./prepare-workspace-tab";

function layoutStoreDeps() {
  const store = useWorkspaceLayoutStore.getState();
  return {
    openTabFocused: store.openTabFocused,
    pinAgent: store.pinAgent,
  };
}

export function prepareWorkspaceTab(input: PrepareWorkspaceTabInput): string {
  return prepareWorkspaceTabPure(input, layoutStoreDeps());
}

export function navigateToPreparedWorkspaceTab(input: NavigateToPreparedWorkspaceTabInput): string {
  return navigateToPreparedWorkspaceTabPure(input, {
    ...layoutStoreDeps(),
    navigateToWorkspace,
  });
}
