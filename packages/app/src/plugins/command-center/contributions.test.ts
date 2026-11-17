import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import { QueryClient } from "@tanstack/react-query";
import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  defineRpc,
  type PluginAgentSnapshot,
  type PluginWorkspaceSnapshot,
} from "@getpaseo/plugin";
import { type PluginCommandCenterItemContribution } from "@getpaseo/plugin/client";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { InstalledPlugin } from "../types";
import { buildPluginCommandCenterContributions } from "./contributions";

import { entityRefs } from "../client-state/refs";
const workspace: PluginWorkspaceSnapshot = {
  ref: entityRefs.workspace("host-1", "workspace-1"),
  hostId: "host-1",
  project: entityRefs.project("host-1", "project-1"),
  pinnedAt: null,
  labels: [],
  background: false,
  branch: null,
  createdAt: null,
  lastPromptAt: null,
  parentAgent: null,
  indicator: "running",
  indicatorLabel: "Running",
  id: "workspace-1",
  projectId: "project-1",
  projectDisplayName: "Paseo",
  projectRootPath: "/repo/paseo",
  directory: "/repo/paseo/review",
  projectKind: "git",
  kind: "worktree",
  name: "Review",
  title: null,
  status: "running",
  statusEnteredAt: null,
  archivingAt: null,
  diffStat: null,
};

const agent: PluginAgentSnapshot = {
  ref: entityRefs.agent("host-1", "agent-1"),
  hostId: "host-1",
  workspace: workspace.ref,
  parentAgent: null,
  id: "agent-1",
  workspaceId: workspace.id,
  provider: "codex",
  status: "running",
  backgroundWork: { count: 0 },
  background: false,
  createdAt: "2026-08-16T10:00:00.000Z",
  updatedAt: "2026-08-16T10:00:00.000Z",
  lastActivityAt: "2026-08-16T10:00:00.000Z",
  title: "Review",
  cwd: workspace.directory,
  model: "gpt-5.6",
  currentModeId: null,
  thinkingOptionId: null,
  requiresAttention: false,
  attentionReason: null,
  parentAgentId: null,
  labels: {},
  metadata: {},
};

const inspect = defineRpc({
  name: "review.inspect",
  input: z.object({ value: z.number() }),
  output: z.object({ value: z.number() }),
});

type AgentCommandItem = Extract<PluginCommandCenterItemContribution, { context: "agent" }>;

function plugin(onAgentSelect: AgentCommandItem["onSelect"]): InstalledPlugin {
  return {
    id: "review",
    serverId: "host-1",
    clientBundle: "bundle",
    lifetime: new AbortController(),
    locale: "en",
    i18n: new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} }),
    paseo: createPaseoApi(
      new DaemonClient({
        url: "ws://127.0.0.1:1",
        clientId: "plugin-command-test",
        clientType: "cli",
      }),
    ),
    subscribe: () => {
      throw new Error("Subscriptions are not used here");
    },
    invoke: async (method: string, input: unknown) => {
      expect(method).toBe("review.inspect");
      return { value: inspect.input.parse(input).value + 1 };
    },
    queryClient: new QueryClient(),
    cleanup: () => {},
    settingsScreens: [],
    surfaces: [{ id: "main", title: "Main", Component: () => null }],
    sidebarViews: [],
    sidebarItems: { header: [], footer: [] },
    legacySidebarItems: [],
    workspaceRowBadgeItems: [],
    filePanels: [],
    composerItems: [],
    newWorkspaceItems: [],
    workspacePanels: [
      {
        id: "details",
        title: "Details",
        icon: "Scan",
        context: "agent",
        locations: ["workspace", "explorer"],
        Component: () => null,
      },
    ],
    commandCenterItems: [
      {
        id: "global",
        title: "Global review",
        icon: "Scan",
        context: "global",
        onSelect: () => {},
      },
      {
        id: "workspace",
        title: "Workspace review",
        icon: "Scan",
        context: "workspace",
        onSelect: () => {},
      },
      {
        id: "agent",
        title: "Agent review",
        icon: "Scan",
        context: "agent",
        onSelect: onAgentSelect,
      },
    ],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
  };
}

function stateSource() {
  return {
    subscribe() {
      return () => {};
    },
    getSnapshot() {
      return { workspaces: [workspace], agents: [agent], projects: [], terminals: [] };
    },
    getProject() {
      return null;
    },
    getTerminal() {
      return null;
    },
    getWorkspace(id: string) {
      return id === workspace.id ? workspace : null;
    },
    getAgent(id: string) {
      return id === agent.id ? agent : null;
    },
  };
}

describe("plugin Command Center contributions", () => {
  it("shows only contributions whose synchronous context exists", () => {
    const installed = plugin(() => undefined);
    const common = {
      plugins: [installed],
      state: stateSource(),
      navigation: {
        openSettings() {},
        openSurface() {},
        openWorkspacePanel() {},
        openAgentPanel() {},
      },
      reportError() {},
    };

    expect(
      buildPluginCommandCenterContributions({
        ...common,
        workspaceId: null,
        agentId: null,
      }).map((item) => item.id),
    ).toEqual(["review:global"]);
    expect(
      buildPluginCommandCenterContributions({
        ...common,
        workspaceId: workspace.id,
        agentId: null,
      }).map((item) => item.id),
    ).toEqual(["review:global", "review:workspace"]);
    expect(
      buildPluginCommandCenterContributions({
        ...common,
        workspaceId: workspace.id,
        agentId: agent.id,
      }).map((item) => item.id),
    ).toEqual(["review:global", "review:workspace", "review:agent"]);
  });

  it("supplies the direct API, typed RPC, snapshots, and narrow navigation", async () => {
    const opened: string[] = [];
    let rpcValue = 0;
    let receivedPaseo: PaseoApi | null = null;
    const installed = plugin(async (context) => {
      expect(context.workspace).toBe(workspace);
      expect(context.agent).toBe(agent);
      receivedPaseo = context.paseo;
      rpcValue = (await context.rpc(inspect, { value: 4 })).value;
      context.openSurface("main");
      context.openPanel("details", { location: "explorer" });
    });
    const actions = buildPluginCommandCenterContributions({
      plugins: [installed],
      state: stateSource(),
      workspaceId: workspace.id,
      agentId: agent.id,
      navigation: {
        openSettings() {},
        openSurface(pluginId, surfaceId) {
          opened.push(`${pluginId}/surface/${surfaceId}`);
        },
        openWorkspacePanel(pluginId, panelId, location) {
          opened.push(`${pluginId}/workspace/${panelId}/${location}`);
        },
        openAgentPanel(pluginId, panelId, agentId, location) {
          opened.push(`${pluginId}/agent/${panelId}/${agentId}/${location}`);
        },
      },
      reportError(error) {
        throw error;
      },
    });

    await actions.find((action) => action.id === "review:agent")?.run();

    expect(rpcValue).toBe(5);
    // Commands use the plugin's one client.
    expect(receivedPaseo).toBe(installed.paseo);
    expect(opened).toEqual(["review/surface/main", "review/agent/details/agent-1/explorer"]);
  });

  it("removes every contribution when its installation disappears", () => {
    expect(
      buildPluginCommandCenterContributions({
        plugins: [],
        state: stateSource(),
        workspaceId: workspace.id,
        agentId: agent.id,
        navigation: {
          openSettings() {},
          openSurface() {},
          openWorkspacePanel() {},
          openAgentPanel() {},
        },
        reportError() {},
      }),
    ).toEqual([]);
  });
});
