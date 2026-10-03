/**
 * @vitest-environment jsdom
 */
import { act } from "@testing-library/react";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

// The real resolver asks every panel registration for its descriptor, and that graph pulls
// packages whose published builds are untransformed. The folder only needs a label per tab.
vi.mock("@/screens/workspace/workspace-tab-presentation", () => ({
  WorkspaceTabPresentationResolver: ({
    tab,
    children,
  }: {
    tab: {
      key: string;
      kind: string;
      target: { kind: string; agentId?: string; terminalId?: string };
    };
    children: (presentation: { label: string }) => unknown;
  }) => children({ label: tab.target.agentId ?? tab.target.terminalId ?? tab.kind }),
  WorkspaceTabIcon: () => null,
}));

const navigateToWorkspaceMock = vi.hoisted(() => vi.fn());
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: navigateToWorkspaceMock,
}));

import { useIsCompactFormFactor } from "@/constants/layout";
import { useAppSettings } from "@/hooks/use-settings";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useWorkspaceLayoutStore, type SplitNode } from "@/stores/workspace-layout-store";
import { seedSessionHosts } from "@/test/seed-session";
import { WorkspaceTabRows, WorkspaceTabsDisclosure } from "./index";

vi.mock("@/hooks/use-settings", () => ({ useAppSettings: vi.fn() }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: vi.fn(() => false) }));

const SERVER_ID = "srv";
const WORKSPACE_ID = "ws-1";
const WORKSPACE_KEY = "srv:ws-1";

function makeAgent(id: string, title: string, createdAt: string): Agent {
  const at = new Date(createdAt);
  return {
    serverId: SERVER_ID,
    id,
    provider: "codex",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: at,
    updatedAt: at,
    lastUserMessageAt: null,
    lastActivityAt: at,
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
    runtimeInfo: { provider: "codex", sessionId: null },
    title,
    cwd: "/repo/worktree",
    workspaceId: WORKSPACE_ID,
    model: null,
    thinkingOptionId: null,
    parentAgentId: null,
    labels: {},
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
  };
}

function seedAgents(agents: Agent[]): void {
  useSessionStore.getState().setAgents(SERVER_ID, new Map(agents.map((a) => [a.id, a])));
}

function seedTerminalLayout(focusedTabId: string | null = null): void {
  const tabs = [
    { tabId: "term-1", target: { kind: "terminal", terminalId: "t1" }, createdAt: 0 },
    { tabId: "term-2", target: { kind: "terminal", terminalId: "t2" }, createdAt: 0 },
  ];
  const root = {
    kind: "pane",
    pane: { id: "main", tabIds: tabs.map((entry) => entry.tabId), focusedTabId, tabs },
  } as unknown as SplitNode;
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: { [WORKSPACE_KEY]: { root, focusedPaneId: "main" } },
  });
}

function setTierEnabled(enabled: boolean): void {
  vi.mocked(useAppSettings).mockReturnValue({
    settings: { sidebarTabRows: enabled },
  } as unknown as ReturnType<typeof useAppSettings>);
}

let container: HTMLDivElement;
let root: Root;

function render(input: { enabled?: boolean; selected?: boolean; hovered?: boolean } = {}): void {
  const enabled = input.enabled ?? true;
  setTierEnabled(enabled);
  act(() => {
    root.render(
      <>
        <WorkspaceTabsDisclosure
          workspaceKey={WORKSPACE_KEY}
          serverId={SERVER_ID}
          workspaceId={WORKSPACE_ID}
          isHovered={input.hovered ?? false}
        >
          <span data-testid="status-indicator" />
        </WorkspaceTabsDisclosure>
        <WorkspaceTabRows
          workspaceKey={WORKSPACE_KEY}
          serverId={SERVER_ID}
          workspaceId={WORKSPACE_ID}
          selected={input.selected ?? false}
          enabled={enabled}
        />
      </>,
    );
  });
}

function rowTitles(): string[] {
  return Array.from(container.querySelectorAll('[data-testid^="sidebar-tab-row-"]')).map(
    (node) => node.textContent?.trim() ?? "",
  );
}

function query(testID: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
}

function expandFolder(): void {
  useSidebarCollapsedSectionsStore.setState({ expandedTabWorkspaceKeys: new Set([WORKSPACE_KEY]) });
}

beforeEach(() => {
  navigateToWorkspaceMock.mockReset();
  vi.mocked(useIsCompactFormFactor).mockReturnValue(false);
  useSidebarCollapsedSectionsStore.setState({ expandedTabWorkspaceKeys: new Set() });
  useWorkspaceLayoutStore.setState({ layoutByWorkspace: {}, hiddenAgentIdsByWorkspace: {} });
  seedSessionHosts([SERVER_ID]);
  seedAgents([]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("WorkspaceTabRows", () => {
  it("renders nothing while the tier is switched off", () => {
    seedTerminalLayout();
    expandFolder();
    render({ enabled: false, hovered: true });
    expect(rowTitles()).toEqual([]);
    expect(query("status-indicator")).not.toBeNull();
  });

  it("stays closed until it is opened", () => {
    seedTerminalLayout();
    render();
    expect(rowTitles()).toEqual([]);
  });

  it("lists the layout's tabs, then agents with no tab yet, once open", () => {
    seedTerminalLayout();
    seedAgents([makeAgent("agent-1", "Fix login", "2026-03-04T09:00:00.000Z")]);
    expandFolder();
    render();
    expect(rowTitles()).toEqual(["t1", "t2", "agent-1"]);
  });

  it("opens the folder of the workspace being viewed", () => {
    seedTerminalLayout();
    render({ selected: true });
    expect(rowTitles()).toEqual(["t1", "t2"]);
    expect(useSidebarCollapsedSectionsStore.getState().expandedTabWorkspaceKeys).toContain(
      WORKSPACE_KEY,
    );
  });

  it("marks the active tab only in the workspace being viewed", () => {
    seedTerminalLayout("term-2");
    expandFolder();
    render({ selected: true });
    const active = query(`sidebar-tab-row-${WORKSPACE_KEY}:term-2`);
    expect(active?.getAttribute("aria-selected")).toBe("true");
    render({ selected: false });
    expect(
      query(`sidebar-tab-row-${WORKSPACE_KEY}:term-2`)?.getAttribute("aria-selected"),
    ).not.toBe("true");
  });

  it("focuses the exact tab pressed and navigates to its workspace", () => {
    seedTerminalLayout("term-1");
    expandFolder();
    render();
    act(() => {
      query(`sidebar-tab-row-${WORKSPACE_KEY}:term-2`)?.click();
    });
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    expect(layout?.root.kind === "pane" && layout.root.pane.focusedTabId).toBe("term-2");
    expect(navigateToWorkspaceMock).toHaveBeenCalledWith({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "terminal", terminalId: "t2" },
    });
  });

  it("opens an agent that has no tab yet through navigation alone", () => {
    seedAgents([makeAgent("agent-1", "Fix login", "2026-03-04T09:00:00.000Z")]);
    expandFolder();
    render();
    act(() => {
      query(`sidebar-tab-row-${WORKSPACE_KEY}:sidebar-pending-agent:agent-1`)?.click();
    });
    expect(navigateToWorkspaceMock).toHaveBeenCalledWith({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "agent", agentId: "agent-1" },
    });
  });
});

describe("compact layouts", () => {
  it("never shows the chevron, since the header's tab switcher covers it", () => {
    vi.mocked(useIsCompactFormFactor).mockReturnValue(true);
    seedTerminalLayout();
    render({ hovered: true });
    expect(query("status-indicator")).not.toBeNull();
    expect(query(`sidebar-workspace-tabs-disclosure-${WORKSPACE_KEY}`)).toBeNull();
  });
});

describe("WorkspaceTabsDisclosure", () => {
  const disclosureID = `sidebar-workspace-tabs-disclosure-${WORKSPACE_KEY}`;

  it("keeps the status indicator when the row is not hovered", () => {
    seedTerminalLayout();
    render({ hovered: false });
    expect(query("status-indicator")).not.toBeNull();
    expect(query(disclosureID)).toBeNull();
  });

  it("keeps the status indicator for a workspace with nothing to open", () => {
    render({ hovered: true });
    expect(query("status-indicator")).not.toBeNull();
    expect(query(disclosureID)).toBeNull();
  });

  it("swaps in the chevron on hover and toggles the folder", () => {
    seedTerminalLayout();
    render({ hovered: true });
    expect(query("status-indicator")).toBeNull();
    act(() => {
      query(disclosureID)?.click();
    });
    expect(rowTitles()).toEqual(["t1", "t2"]);
    act(() => {
      query(disclosureID)?.click();
    });
    expect(rowTitles()).toEqual([]);
  });
});
