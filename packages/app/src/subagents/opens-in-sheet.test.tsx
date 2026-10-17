/**
 * @vitest-environment jsdom
 */
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { useSubagentOpensInSheet } from "./opens-in-sheet";
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
  const child: Agent = { ...AGENT_DEFAULTS, id: "child", title: "Child", parentAgentId: "parent" };
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

describe("useSubagentOpensInSheet", () => {
  it("re-renders the row's answer as the child's tab opens and closes", () => {
    const row = seedParentWithChild();
    const store = useWorkspaceLayoutStore.getState();
    store.setLayoutMode("compact");
    const target = { kind: "agent", agentId: "child" } as const;

    // The row renders its answer, as the track does, so a stale render is a stale answer.
    const { result } = renderHook(() => useSubagentOpensInSheet(workspaceKey)(row));
    expect(result.current).toBe(true);

    let tabId: string | null = null;
    act(() => {
      const sheetTabId = store.openTab({ workspaceKey, target, intent: "reveal" });
      tabId = sheetTabId ? store.openSheetAsTab(workspaceKey, sheetTabId) : null;
    });
    expect(tabId).not.toBeNull();
    expect(result.current).toBe(false);

    act(() => {
      store.closeTab(workspaceKey, tabId ?? "");
    });
    expect(result.current).toBe(true);
  });
});
