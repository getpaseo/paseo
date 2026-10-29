/**
 * @vitest-environment jsdom
 */
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { parentAddressLabels } from "@getpaseo/protocol/agent-labels";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { normalizeAgentSnapshot, projectAgentSnapshot } from "@/utils/agent-snapshots";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { useSubagentSheetTab } from "./sheet-tab";
import { selectSubagentsForParent, type SubagentRow } from "./select";

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

const SERVER_ID = "server-1";
const WORKSPACE_ID = "ws-main";
const AGENT_TIMESTAMP = new Date("2026-04-21T10:00:00.000Z");

const AGENT_DEFAULTS: Agent = {
  serverId: SERVER_ID,
  id: "agent",
  provider: "codex",
  status: "idle",
  turn: { phase: "idle", cancellationRequestId: null },
  createdAt: AGENT_TIMESTAMP,
  updatedAt: AGENT_TIMESTAMP,
  lastUserMessageAt: null,
  lastActivityAt: AGENT_TIMESTAMP,
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  runtimeInfo: undefined,
  lastUsage: undefined,
  lastError: null,
  title: "Agent",
  cwd: "/repo/worktree",
  workspaceId: WORKSPACE_ID,
  model: null,
  features: undefined,
  thinkingOptionId: undefined,
  requiresAttention: false,
  attentionReason: null,
  attentionTimestamp: null,
  archivedAt: null,
  parentAgentId: null,
  labels: {},
  projectPlacement: null,
};

const workspaceKey = buildWorkspaceTabPersistenceKey({
  serverId: SERVER_ID,
  workspaceId: WORKSPACE_ID,
});
if (!workspaceKey) throw new Error("workspace key");

function seedParentWithChild(): SubagentRow {
  const parent: Agent = { ...AGENT_DEFAULTS, id: "parent", title: "Parent" };
  const child = normalizeAgentSnapshot(
    projectAgentSnapshot({
      ...AGENT_DEFAULTS,
      id: "child",
      title: "Child",
      labels: parentAddressLabels({ serverId: SERVER_ID, agentId: parent.id }),
    }),
    SERVER_ID,
  );
  useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
  useSessionStore.getState().setAgents(
    SERVER_ID,
    new Map([
      [parent.id, parent],
      [child.id, child],
    ]),
  );
  const [row] = selectSubagentsForParent(
    useSessionStore.getState(),
    { serverId: SERVER_ID, parentAgentId: "parent" },
    new Set(),
  );
  if (!row) throw new Error("child row");
  return row;
}

afterEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
  useWorkspaceLayoutStore.setState({
    layoutMode: "split-panes",
    layoutByWorkspace: {},
    sheetsByWorkspace: {},
    hiddenAgentIdsByWorkspace: {},
    pinnedAgentIdsByWorkspace: {},
  });
});

describe("useSubagentSheetTab", () => {
  it("re-renders the row's sheet as the child's tab opens and closes", () => {
    const row = seedParentWithChild();
    const store = useWorkspaceLayoutStore.getState();
    store.setLayoutMode("compact");

    // The row renders its answer, as the track does, so a stale render is a stale answer.
    const { result } = renderHook(() => useSubagentSheetTab(workspaceKey, "parent-tab")(row));
    expect(result.current?.tab.target).toEqual({ kind: "agent", agentId: "child" });

    let tabId: string | null = null;
    act(() => {
      tabId = result.current ? store.openTabInFront(workspaceKey, result.current) : null;
    });
    expect(tabId).not.toBeNull();
    expect(result.current).toBeNull();

    act(() => {
      store.closeTab(workspaceKey, tabId ?? "");
    });
    expect(result.current?.tab.tabId).toBe(tabId);
  });

  it("hands a re-rendered row the same sheet", () => {
    const row = seedParentWithChild();
    useWorkspaceLayoutStore.getState().setLayoutMode("compact");

    const { result, rerender } = renderHook(() =>
      useSubagentSheetTab(workspaceKey, "parent-tab")(row),
    );
    const first = result.current;
    rerender();

    expect(first).not.toBeNull();
    expect(result.current).toBe(first);
  });
});
