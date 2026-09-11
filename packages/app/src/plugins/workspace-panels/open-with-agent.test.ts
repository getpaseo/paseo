import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import { QueryClient } from "@tanstack/react-query";
import type { PluginAgentSnapshot, PluginWorkspaceSnapshot } from "@getpaseo/plugin";
import {
  collectAllPanes,
  collectAllTabs,
  useWorkspaceLayoutStore,
  type WorkspaceTabPlacement,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { InstalledPlugin } from "../types";
import { arrangePanelWithAgent, resolvePanelWithAgent } from "./open-with-agent";

const KEY = "server-1:workspace-1";
const panel = {
  kind: "plugin",
  pluginId: "reader",
  panelId: "view",
  context: "workspace",
} as const;
const agent = { kind: "agent", agentId: "agent-1" } as const;

beforeEach(() => {
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
    sidePaneIdByWorkspace: {},
    splitSizesByWorkspace: {},
  });
});

function layout() {
  const current = useWorkspaceLayoutStore.getState().layoutByWorkspace[KEY];
  if (!current) throw new Error("Workspace layout was not created");
  return current;
}
const panes = () => collectAllPanes(layout().root);
const paneWithTab = (tabId: string) => panes().find((pane) => pane.tabIds.includes(tabId));
const tabs = (kind: WorkspaceTabTarget["kind"]) =>
  collectAllTabs(layout().root).filter((tab) => tab.target.kind === kind);
const sidePaneId = () => useWorkspaceLayoutStore.getState().sidePaneIdByWorkspace[KEY] ?? null;
const explorerPaneId = () =>
  useWorkspaceLayoutStore.getState().explorerSidebarPaneIdByWorkspace[KEY] ?? null;

function open(target: WorkspaceTabTarget, placement?: WorkspaceTabPlacement): string {
  const tabId = useWorkspaceLayoutStore
    .getState()
    .openTab({ workspaceKey: KEY, target, intent: "reveal", placement });
  if (!tabId) throw new Error("Tab did not open");
  return tabId;
}

function arrange() {
  return arrangePanelWithAgent({ workspaceKey: KEY, panel, agent });
}

/** The reader sits in a main pane with focus, and the only chat tab sits in the right-hand side pane. */
function expectReaderLeftChatRight() {
  const [reader] = tabs("plugin");
  const [chat] = tabs("agent");
  expect(tabs("plugin")).toHaveLength(1);
  expect(tabs("agent")).toHaveLength(1);
  const side = sidePaneId();
  const readerPane = paneWithTab(reader.tabId);
  expect(readerPane?.id).not.toBe(side);
  expect(readerPane?.id).not.toBe(explorerPaneId());
  expect(readerPane?.focusedTabId).toBe(reader.tabId);
  expect(paneWithTab(chat.tabId)?.id).toBe(side);
  expect(paneWithTab(chat.tabId)?.focusedTabId).toBe(chat.tabId);
  const root = layout().root;
  expect(root.kind).toBe("group");
  if (root.kind !== "group") return { reader, chat };
  expect(root.group.direction).toBe("horizontal");
  const right = root.group.children.at(-1);
  expect(right?.kind === "pane" ? right.pane.id : null).toBe(side);
  return { reader, chat };
}

describe("arrangePanelWithAgent", () => {
  it("opens the panel in the main pane and the chat in a new side pane on the right", () => {
    const agentPaneId = arrange();
    expect(agentPaneId).toBe(sidePaneId());
    expectReaderLeftChatRight();
  });

  it("moves a reader docked in Explorer back to main and moves the existing chat tab beside it", () => {
    const chatTabId = open(agent);
    const explorer = useWorkspaceLayoutStore.getState().showExplorerSidebar(KEY);
    expect(explorer).toBeTruthy();
    const readerTabId = open(panel, { mode: "pane", paneId: explorer as string });
    expect(paneWithTab(readerTabId)?.id).toBe(explorer);

    arrange();

    const { reader, chat } = expectReaderLeftChatRight();
    expect(reader.tabId).toBe(readerTabId);
    expect(chat.tabId).toBe(chatTabId);
  });

  it("keeps the reader focused in main when the focused chat moves out of that pane", () => {
    const readerTabId = open(panel);
    const chatTabId = open(agent);
    expect(paneWithTab(readerTabId)?.focusedTabId).toBe(chatTabId);

    arrange();

    const { reader, chat } = expectReaderLeftChatRight();
    expect(reader.tabId).toBe(readerTabId);
    expect(chat.tabId).toBe(chatTabId);
  });

  it("swaps a reader in the side pane with a chat in main without duplicating either tab", () => {
    const chatTabId = open(agent);
    const side = useWorkspaceLayoutStore.getState().ensureSidePane(KEY);
    const readerTabId = open(panel, { mode: "pane", paneId: side as string });
    expect(paneWithTab(readerTabId)?.id).toBe(side);

    arrange();

    const { reader, chat } = expectReaderLeftChatRight();
    expect(reader.tabId).toBe(readerTabId);
    expect(chat.tabId).toBe(chatTabId);
  });

  it("reuses an existing right side pane that already holds the chat", () => {
    open(panel);
    const side = useWorkspaceLayoutStore.getState().ensureSidePane(KEY);
    open(agent, { mode: "pane", paneId: side as string });
    const paneIds = panes().map((pane) => pane.id);

    expect(arrange()).toBe(side);

    expect(panes().map((pane) => pane.id)).toEqual(paneIds);
    expectReaderLeftChatRight();
  });

  it("is stable across repeated opens", () => {
    arrange();
    const first = { panes: panes().map((pane) => [pane.id, [...pane.tabIds]]), side: sidePaneId() };
    arrange();
    arrange();
    expect({
      panes: panes().map((pane) => [pane.id, [...pane.tabIds]]),
      side: sidePaneId(),
    }).toEqual(first);
    expectReaderLeftChatRight();
  });
});

const workspace: PluginWorkspaceSnapshot = {
  id: "workspace-1",
  projectId: "project-1",
  projectDisplayName: "Paseo",
  projectRootPath: "/repo/paseo",
  directory: "/repo/paseo",
  projectKind: "git",
  kind: "local_checkout",
  name: "main",
  title: null,
  status: "running",
  statusEnteredAt: null,
  archivingAt: null,
  diffStat: null,
};

function agentSnapshot(id: string, workspaceId: string): PluginAgentSnapshot {
  return {
    id,
    workspaceId,
    provider: "claude",
    status: "idle",
    createdAt: "2026-09-11T10:00:00.000Z",
    updatedAt: "2026-09-11T10:00:00.000Z",
    lastActivityAt: "2026-09-11T10:00:00.000Z",
    title: "Chat",
    cwd: workspace.directory,
    model: null,
    currentModeId: null,
    thinkingOptionId: null,
    requiresAttention: false,
    attentionReason: null,
    parentAgentId: null,
    labels: {},
  };
}

function installed(): InstalledPlugin {
  const Component = () => null;
  return {
    id: "reader",
    serverId: "server-1",
    clientBundle: "bundle",
    lifetime: new AbortController(),
    queryClient: new QueryClient(),
    cleanup: () => {},
    surfaces: [],
    settingsScreens: [],
    sidebarItems: [],
    workspacePanels: [
      {
        id: "view",
        title: "View",
        icon: "Scan",
        context: "workspace",
        locations: ["workspace", "explorer"],
        Component,
      },
      {
        id: "agent-view",
        title: "Agent",
        icon: "Scan",
        context: "agent",
        locations: ["workspace"],
        Component,
      },
      {
        id: "dock-only",
        title: "Dock",
        icon: "Scan",
        context: "workspace",
        locations: ["explorer"],
        Component,
      },
    ],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
  };
}

const state = {
  subscribe: () => () => {},
  getWorkspace: (id: string) => (id === workspace.id ? workspace : null),
  getAgent: (id: string) => {
    if (id === "agent-1") return agentSnapshot(id, workspace.id);
    if (id === "elsewhere") return agentSnapshot(id, "workspace-2");
    return null;
  },
};

describe("resolvePanelWithAgent", () => {
  const request = {
    plugin: installed(),
    state,
    panelId: "view",
    workspaceId: "workspace-1",
    agentId: "agent-1",
  };

  it("returns the workspace panel and agent targets", () => {
    expect(resolvePanelWithAgent({ ...request, panelId: " view ", agentId: " agent-1 " })).toEqual({
      workspaceId: "workspace-1",
      panel: { kind: "plugin", pluginId: "reader", panelId: "view", context: "workspace" },
      agent: { kind: "agent", agentId: "agent-1" },
    });
  });

  it("rejects panels that cannot be hosted in the main pane", () => {
    for (const panelId of ["missing", "agent-view", "dock-only"]) {
      expect(() => resolvePanelWithAgent({ ...request, panelId })).toThrow(
        `Workspace panel is unavailable: ${panelId}`,
      );
    }
  });

  it("rejects agents outside the workspace and unknown workspaces", () => {
    expect(() => resolvePanelWithAgent({ ...request, agentId: "elsewhere" })).toThrow(
      "Agent is unavailable in this workspace",
    );
    expect(() => resolvePanelWithAgent({ ...request, agentId: "missing" })).toThrow(
      "Agent is unavailable in this workspace",
    );
    expect(() => resolvePanelWithAgent({ ...request, workspaceId: "workspace-2" })).toThrow(
      "Agent is unavailable in this workspace",
    );
  });
});
