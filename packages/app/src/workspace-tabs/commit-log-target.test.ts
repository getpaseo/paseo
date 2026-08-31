import { beforeEach, describe, expect, it, vi } from "vitest";

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

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  collectAllTabs,
  createWorkspaceLayoutStore,
  stripEphemeralTabsFromLayout,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import {
  buildDeterministicWorkspaceTabId,
  normalizeWorkspaceTabTarget,
  workspaceTabTargetsEqual,
} from "@/workspace-tabs/identity";
import { getPanelManifest, panelSupportsHost } from "@/panels/panel-manifest";

const COMMIT_LOG = { kind: "commit_log" } as const;

beforeEach(async () => {
  await AsyncStorage.removeItem("workspace-layout-state");
  useWorkspaceLayoutStore.setState({ layoutByWorkspace: {}, splitSizesByWorkspace: {} });
});

describe("commit_log tab identity", () => {
  it("normalizes to itself instead of being dropped", () => {
    expect(normalizeWorkspaceTabTarget(COMMIT_LOG)).toEqual(COMMIT_LOG);
  });

  it("compares equal so reveal focuses the existing tab", () => {
    expect(workspaceTabTargetsEqual(COMMIT_LOG, { kind: "commit_log" })).toBe(true);
    expect(workspaceTabTargetsEqual(COMMIT_LOG, { kind: "files" })).toBe(false);
  });

  it("has a stable deterministic tab id", () => {
    expect(buildDeterministicWorkspaceTabId(COMMIT_LOG)).toBe("commit_log");
  });

  it("opens in both the main and explorer panes", () => {
    expect(getPanelManifest("commit_log").resourceKey(COMMIT_LOG)).toBe("commit_log");
    expect(panelSupportsHost("commit_log", "main")).toBe(true);
    expect(panelSupportsHost("commit_log", "explorer")).toBe(true);
  });
});

describe("commit_log tab persistence", () => {
  it("survives a rehydrate instead of dropping every persisted tab", async () => {
    const store = createWorkspaceLayoutStore();
    store.getState().openTab({
      workspaceKey: "workspace",
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    store.getState().openTab({
      workspaceKey: "workspace",
      target: COMMIT_LOG,
      intent: "reveal",
    });
    // Zustand persist writes on a microtask; flush before reading storage.
    await Promise.resolve();

    const restored = createWorkspaceLayoutStore();
    await restored.persist.rehydrate();

    const targets = collectAllTabs(
      restored.getState().layoutByWorkspace.workspace?.root ?? {
        kind: "pane",
        pane: null as never,
      },
    ).map((tab) => tab.target);

    // The whole point: a missing storage-schema branch fails safeParse for the
    // entire persisted state, so the agent tab would vanish too.
    expect(targets).toContainEqual(COMMIT_LOG);
    expect(targets).toContainEqual({ kind: "agent", agentId: "agent-1" });
  });

  it("is not stripped as an ephemeral tab", () => {
    const store = createWorkspaceLayoutStore();
    store.getState().openTab({
      workspaceKey: "workspace",
      target: COMMIT_LOG,
      intent: "reveal",
    });
    store.getState().openTab({
      workspaceKey: "workspace",
      target: { kind: "commit_diff", sha: "abc1234" },
      intent: "reveal",
    });

    const layout = store.getState().layoutByWorkspace.workspace;
    const targets = collectAllTabs(stripEphemeralTabsFromLayout(layout).root).map(
      (tab) => tab.target,
    );

    expect(targets).toContainEqual(COMMIT_LOG);
    expect(targets).not.toContainEqual({ kind: "commit_diff", sha: "abc1234" });
  });
});
