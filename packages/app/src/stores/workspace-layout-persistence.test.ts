import { describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import { createWorkspaceLayoutStore } from "./workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

function createMemoryStorage(): StateStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

const backgroundTargets: WorkspaceTabTarget[] = [
  { kind: "background_activity" },
  { kind: "background_thread", conversationId: "conversation-1" },
  { kind: "background_thread", conversationId: "conversation-1", requestId: "request-1" },
];

describe("workspace layout persistence", () => {
  it.each(backgroundTargets)("preserves all workspaces after opening %j", async (target) => {
    const storage = createMemoryStorage();
    const source = createWorkspaceLayoutStore(undefined, storage);
    await source.persist.rehydrate();
    for (const workspaceKey of ["host:first", "host:second"]) {
      source.getState().openTab({
        workspaceKey,
        target: { kind: "agent", agentId: workspaceKey },
        intent: "reveal",
      });
    }
    const workspaceKey = "host:first";
    const paneId = source
      .getState()
      .splitPaneEmpty(workspaceKey, { targetPaneId: "main", position: "right" });
    expect(typeof paneId).toBe("string");
    source.getState().openTab({
      workspaceKey,
      target: { kind: "terminal", terminalId: "terminal-1" },
      intent: "reveal",
      placement: { mode: "prefer", paneId: paneId! },
    });
    source.getState().openTab({ workspaceKey, target, intent: "reveal" });
    source.getState().hideExplorerSidebar(workspaceKey);
    const expected = source.getState().layoutByWorkspace;

    // Read the actual envelope written by the store's validation adapter before recreating it.
    const raw = await storage.getItem("workspace-layout-state");
    expect(JSON.parse(raw ?? "null")).toMatchObject({
      state: { layoutByWorkspace: JSON.parse(JSON.stringify(expected)) },
    });
    const restored = createWorkspaceLayoutStore(undefined, storage);
    await restored.persist.rehydrate();
    expect(restored.getState().layoutByWorkspace).toEqual(expected);
    expect(restored.getState().explorerSidebarPaneIdByWorkspace).toEqual({
      "host:first": "explorer",
      "host:second": "explorer",
    });
  });
});
