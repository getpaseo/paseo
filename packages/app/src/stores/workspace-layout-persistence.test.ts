import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import { createWorkspaceLayoutStore } from "./workspace-layout-store";

Object.assign(globalThis, { indexedDB, IDBKeyRange });

it("skips unchanged reconciliations and immediately saves real layout changes", async () => {
  const values = new Map<string, string>();
  let writes = 0;
  const storage: StateStorage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      writes += 1;
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    },
  };
  const store = createWorkspaceLayoutStore(undefined, storage);
  await store.persist.rehydrate();
  const workspaceKey = "server:workspace";
  const openAgent = (agentId: string) =>
    store.getState().openTab({
      workspaceKey,
      target: { kind: "agent", agentId },
      intent: "reveal",
    });
  openAgent("agent-1");
  const layout = store.getState().layoutByWorkspace[workspaceKey];
  const writesBefore = writes;
  expect(writesBefore).toBe(1);
  for (let index = 0; index < 50; index += 1) {
    store.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["agent-1"],
      autoOpenAgentIds: ["agent-1"],
      knownTerminalIds: [],
      standaloneTerminalIds: [],
    });
  }
  expect(store.getState().layoutByWorkspace[workspaceKey]).toBe(layout);
  expect(writes).toBe(writesBefore);

  openAgent("agent-2");
  expect(writes).toBe(writesBefore + 1);
  const restored = createWorkspaceLayoutStore(undefined, storage);
  await restored.persist.rehydrate();
  expect(restored.getState().layoutByWorkspace[workspaceKey]).toEqual(
    store.getState().layoutByWorkspace[workspaceKey],
  );
});

it("keeps the saved layout when the shell publishes its layout mode before hydration", async () => {
  const values = new Map<string, string>();
  const storage: StateStorage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    },
  };
  const workspaceKey = "server:workspace";
  const saved = createWorkspaceLayoutStore(undefined, storage);
  await saved.persist.rehydrate();
  saved.getState().openTab({
    workspaceKey,
    target: { kind: "file", path: "notes.md" },
    intent: "reveal",
  });

  // A page load: the shell publishes its mode from the first commit, before the read settles.
  const loaded = createWorkspaceLayoutStore(undefined, storage);
  loaded.getState().setLayoutMode("single-pane");
  await new Promise<void>((resolve) => loaded.persist.onFinishHydration(() => resolve()));
  expect(loaded.getState().layoutByWorkspace[workspaceKey]).toEqual(
    saved.getState().layoutByWorkspace[workspaceKey],
  );

  // Leaving the page before any other layout change must not lose the tabs.
  const reloaded = createWorkspaceLayoutStore(undefined, storage);
  await reloaded.persist.rehydrate();
  expect(reloaded.getState().layoutByWorkspace[workspaceKey]).toEqual(
    saved.getState().layoutByWorkspace[workspaceKey],
  );
});
