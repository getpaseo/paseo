import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  prepareWorkspaceTab as prepareWorkspaceTabPure,
  type PrepareWorkspaceTabInput,
} from "./prepare-workspace-tab";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

export type { PrepareWorkspaceTabInput } from "./prepare-workspace-tab";

function layoutStoreDeps() {
  const store = useWorkspaceLayoutStore.getState();
  return {
    openTab: (input: { workspaceKey: string; target: WorkspaceTabTarget; intent: "reveal" }) =>
      store.openTab(input),
    pinAgent: store.pinAgent,
  };
}

export function prepareWorkspaceTab(input: PrepareWorkspaceTabInput): void {
  prepareWorkspaceTabPure(input, layoutStoreDeps());
}
