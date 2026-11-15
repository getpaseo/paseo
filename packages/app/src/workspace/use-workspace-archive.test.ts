import { expect, it } from "vitest";
import { useExplorerSplitStore } from "@/stores/explorer-split-store";
import { purgeArchivedWorkspaceState } from "@/workspace/use-workspace-archive";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

it("clears the archived workspace's saved Explorer split and keeps other workspaces' splits", () => {
  const archivedKey = buildWorkspaceTabPersistenceKey({ serverId: "server", workspaceId: "gone" });
  const keptKey = buildWorkspaceTabPersistenceKey({ serverId: "server", workspaceId: "kept" });
  const lowerTab = { tabId: "terminal_1", target: { kind: "terminal" as const, terminalId: "1" } };
  useExplorerSplitStore.getState().showBelow(archivedKey!, lowerTab);
  useExplorerSplitStore.getState().showBelow(keptKey!, lowerTab);

  purgeArchivedWorkspaceState({ serverId: "server", workspaceId: "gone" });

  expect(useExplorerSplitStore.getState().entries[archivedKey!]).toBeUndefined();
  expect(useExplorerSplitStore.getState().entries[keptKey!]?.lowerTabId).toBe("terminal_1");
});
