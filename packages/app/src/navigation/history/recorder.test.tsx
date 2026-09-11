/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

interface RouteSnapshot {
  pathname: string;
  params: Record<string, string>;
}

const routeStore = vi.hoisted(() => {
  let state: { pathname: string; params: Record<string, string> } = { pathname: "/", params: {} };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (next: { pathname: string; params?: Record<string, string> }) => {
      state = { pathname: next.pathname, params: next.params ?? {} };
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

vi.mock("expo-router", async () => {
  const ReactModule = await import("react");
  return {
    usePathname: () =>
      ReactModule.useSyncExternalStore(routeStore.subscribe, () => routeStore.get().pathname),
    useLocalSearchParams: () =>
      ReactModule.useSyncExternalStore(routeStore.subscribe, () => routeStore.get().params),
    router: { navigate: vi.fn(), push: vi.fn(), replace: vi.fn() },
  };
});

import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { HistoryEntry } from "./model";
import { NavigationHistoryRecorder } from "./recorder";
import { createNavigationHistoryStore } from "./store";

const WS1 = "srv:ws-1";
const WS2 = "srv:ws-2";
// Main-pane targets with deterministic ids. `files` / `changes_tree` live in the Explorer
// sidebar pane, which the recorder ignores.
const AGENT = { kind: "agent", agentId: "a1" } as const;
const TERMINAL = { kind: "terminal", terminalId: "t1" } as const;

const ws = (
  workspaceId: string,
  tabId: string | null,
  target: Extract<HistoryEntry, { kind: "workspace" }>["target"] = null,
): HistoryEntry => ({ kind: "workspace", serverId: "srv", workspaceId, tabId, target });

describe("NavigationHistoryRecorder", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let history: ReturnType<typeof createNavigationHistoryStore>;

  const layout = () => useWorkspaceLayoutStore.getState();

  const navigate = (snapshot: RouteSnapshot | string) => {
    act(() => {
      routeStore.set(typeof snapshot === "string" ? { pathname: snapshot } : snapshot);
    });
  };

  beforeEach(async () => {
    await useWorkspaceLayoutStore.persist.rehydrate();
    layout().purgeWorkspace(WS1);
    layout().purgeWorkspace(WS2);
    routeStore.set({ pathname: "/" });
    history = createNavigationHistoryStore();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<NavigationHistoryRecorder store={history} />);
    });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
  });

  it("records nothing for transient routes", () => {
    navigate("/welcome");
    navigate("/h/srv");
    expect(history.getState().entries).toEqual([]);
  });

  it("records app-wide routes and workspaces as the pathname changes", () => {
    navigate("/settings/general");
    navigate("/h/srv/workspace/ws-1");
    navigate("/sessions");

    expect(history.getState().entries).toEqual([
      { kind: "route", path: "/settings/general" },
      ws("ws-1", null),
      { kind: "route", path: "/sessions" },
    ]);
    expect(history.getState().index).toBe(2);
  });

  it("records the focused tab and follows tab changes inside the active workspace", () => {
    act(() => {
      layout().openTab({ workspaceKey: WS1, target: AGENT, intent: "reveal" });
    });
    navigate("/h/srv/workspace/ws-1");
    act(() => {
      layout().openTab({ workspaceKey: WS1, target: TERMINAL, intent: "reveal" });
    });
    act(() => {
      layout().focusTab(WS1, "agent_a1");
    });

    expect(history.getState().entries).toEqual([
      ws("ws-1", "agent_a1", AGENT),
      ws("ws-1", "terminal_t1", TERMINAL),
      ws("ws-1", "agent_a1", AGENT),
    ]);
  });

  it("refreshes a tab's replay target when its id is retained during replacement", () => {
    act(() => {
      layout().openTab({ workspaceKey: WS1, target: AGENT, intent: "reveal" });
    });
    navigate("/h/srv/workspace/ws-1");

    act(() => {
      layout().replaceTab(WS1, "agent_a1", { kind: "agent", agentId: "a2" });
    });

    expect(history.getState().entries).toEqual([
      ws("ws-1", "agent_a1", { kind: "agent", agentId: "a2" }),
    ]);
  });

  it("ignores tab changes in a workspace that is not on screen", () => {
    act(() => {
      layout().openTab({ workspaceKey: WS1, target: AGENT, intent: "reveal" });
    });
    navigate("/h/srv/workspace/ws-1");
    act(() => {
      layout().openTab({ workspaceKey: WS2, target: TERMINAL, intent: "reveal" });
      layout().openTab({ workspaceKey: WS2, target: AGENT, intent: "reveal" });
    });

    expect(history.getState().entries).toEqual([ws("ws-1", "agent_a1", AGENT)]);
  });

  it("does not record while pane focus is parked in the composer", () => {
    act(() => {
      layout().openTab({ workspaceKey: WS1, target: AGENT, intent: "reveal" });
    });
    navigate("/h/srv/workspace/ws-1");
    act(() => {
      layout().unfocusPane(WS1);
    });

    expect(history.getState().entries).toEqual([ws("ws-1", "agent_a1", AGENT)]);
  });

  it("treats landing on the current entry after a replay as a no-op", () => {
    act(() => {
      layout().openTab({ workspaceKey: WS1, target: AGENT, intent: "reveal" });
      layout().openTab({ workspaceKey: WS2, target: TERMINAL, intent: "reveal" });
    });
    navigate("/h/srv/workspace/ws-1");
    navigate("/h/srv/workspace/ws-2");
    expect(history.getState().index).toBe(1);

    // What goHistory(-1) does: move the index, then navigate.
    act(() => {
      history.setIndex(0);
    });
    navigate("/h/srv/workspace/ws-1");

    expect(history.getState().entries).toHaveLength(2);
    expect(history.getState().index).toBe(0);

    // A genuine new navigation afterwards truncates the forward branch.
    navigate("/settings/general");
    expect(history.getState().entries).toEqual([
      ws("ws-1", "agent_a1", AGENT),
      { kind: "route", path: "/settings/general" },
    ]);
  });

  it("picks up the workspace from route params on cold mount at /", () => {
    act(() => {
      layout().openTab({ workspaceKey: WS1, target: AGENT, intent: "reveal" });
    });
    navigate({ pathname: "/", params: { serverId: "srv", workspaceId: "ws-1" } });

    expect(history.getState().entries).toEqual([ws("ws-1", "agent_a1", AGENT)]);
  });
});
