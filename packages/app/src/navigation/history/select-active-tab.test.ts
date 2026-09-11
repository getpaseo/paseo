import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

import { createWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { selectActiveWorkspaceTabId } from "./select-active-tab";

const KEY = "srv:ws-1";
// Main-pane targets. `files` / `changes_tree` are Explorer sidebar views, which the selector
// ignores on purpose.
const AGENT = { kind: "agent", agentId: "a1" } as const;
const TERMINAL = { kind: "terminal", terminalId: "t1" } as const;

function createStore() {
  let counter = 0;
  return createWorkspaceLayoutStore({
    createNodeId: (prefix: "pane" | "group") => `${prefix}_${(counter += 1)}`,
    createFocusRestorationToken: () => `token_${(counter += 1)}`,
  });
}

describe("selectActiveWorkspaceTabId", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore();
  });

  it("returns null when the workspace has no layout", () => {
    expect(selectActiveWorkspaceTabId(store.getState(), KEY)).toBeNull();
  });

  it("returns the focused pane's focused tab", () => {
    const agentTabId = store
      .getState()
      .openTab({ workspaceKey: KEY, target: AGENT, intent: "reveal" });
    store.getState().openTab({ workspaceKey: KEY, target: TERMINAL, intent: "reveal" });

    expect(selectActiveWorkspaceTabId(store.getState(), KEY)).toBe("terminal_t1");

    store.getState().focusTab(KEY, agentTabId!);
    expect(selectActiveWorkspaceTabId(store.getState(), KEY)).toBe("agent_a1");
  });

  it("keeps reporting the tab while pane focus is parked in the composer", () => {
    store.getState().openTab({ workspaceKey: KEY, target: AGENT, intent: "reveal" });
    const token = store.getState().unfocusPane(KEY);

    expect(store.getState().layoutByWorkspace[KEY]?.focusedPaneId).toBeNull();
    expect(selectActiveWorkspaceTabId(store.getState(), KEY)).toBe("agent_a1");

    if (token) {
      store.getState().restorePaneFocus(KEY, token);
    }
    expect(selectActiveWorkspaceTabId(store.getState(), KEY)).toBe("agent_a1");
  });

  it("keeps reporting the main tab when the user focuses the Explorer sidebar", () => {
    store.getState().openTab({ workspaceKey: KEY, target: AGENT, intent: "reveal" });
    const explorerPaneId = store.getState().showExplorerSidebar(KEY);
    expect(explorerPaneId).not.toBeNull();

    // The store steers workspace focus away from the Explorer pane itself, so the selector sees
    // the main pane throughout.
    store.getState().focusPane(KEY, explorerPaneId!);

    expect(store.getState().layoutByWorkspace[KEY]?.focusedPaneId).not.toBe(explorerPaneId);
    expect(selectActiveWorkspaceTabId(store.getState(), KEY)).toBe("agent_a1");
  });

  it("returns null if a layout ever reports the Explorer pane as focused", () => {
    store.getState().openTab({ workspaceKey: KEY, target: AGENT, intent: "reveal" });
    const explorerPaneId = store.getState().showExplorerSidebar(KEY);
    const state = store.getState();
    const layout = state.layoutByWorkspace[KEY]!;

    // Persisted layouts predate the focus steering; guard against one that still points there.
    expect(
      selectActiveWorkspaceTabId(
        {
          ...state,
          layoutByWorkspace: { [KEY]: { ...layout, focusedPaneId: explorerPaneId } },
        },
        KEY,
      ),
    ).toBeNull();
  });
});
