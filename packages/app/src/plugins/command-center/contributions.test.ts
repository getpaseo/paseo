import { QueryClient } from "@tanstack/react-query";
import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  defineRpc,
  type PluginAgentSnapshot,
  type PluginCommandCenterItemContribution,
  type PluginWorkspaceSnapshot,
} from "@getpaseo/plugin";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { InstalledPlugin } from "../types";
import { buildPluginCommandCenterContributions } from "./contributions";

const workspace: PluginWorkspaceSnapshot = {
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
  id: "agent-1",
  workspaceId: workspace.id,
  provider: "codex",
  status: "running",
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
    queryClient: new QueryClient(),
    cleanup: () => {},
    surfaces: [{ id: "main", Component: () => null }],
    sidebarItems: [],
    workspacePanels: [
      {
        id: "details",
        title: "Details",
        icon: "Scan",
        context: "agent",
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
    attachmentSources: [],
    themes: [],
  };
}

function stateSource() {
  return {
    subscribe() {
      return () => {};
    },
    getWorkspace(id: string) {
      return id === workspace.id ? workspace : null;
    },
    getAgent(id: string) {
      return id === agent.id ? agent : null;
    },
  };
}

function createRuntime(pluginId: string) {
  const client = new DaemonClient({
    url: "ws://127.0.0.1:1",
    clientId: "plugin-command-test",
    clientType: "cli",
  });
  return {
    paseo: createPaseoApi(client),
    invoke: async (method: string, input: unknown) => {
      expect(pluginId).toBe("review");
      expect(method).toBe("review.inspect");
      return { value: inspect.input.parse(input).value + 1 };
    },
  };
}

describe("plugin Command Center contributions", () => {
  it("shows only contributions whose synchronous context exists", () => {
    const installed = plugin(() => undefined);
    const common = {
      plugins: [installed],
      runtime: createRuntime,
      state: stateSource(),
      navigation: {
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
      context.openPanel("details");
    });
    const runtime = createRuntime("review");
    const actions = buildPluginCommandCenterContributions({
      plugins: [installed],
      runtime: () => runtime,
      state: stateSource(),
      workspaceId: workspace.id,
      agentId: agent.id,
      navigation: {
        openSurface(pluginId, surfaceId) {
          opened.push(`${pluginId}/surface/${surfaceId}`);
        },
        openWorkspacePanel(pluginId, panelId) {
          opened.push(`${pluginId}/workspace/${panelId}`);
        },
        openAgentPanel(pluginId, panelId, agentId) {
          opened.push(`${pluginId}/agent/${panelId}/${agentId}`);
        },
      },
      reportError(error) {
        throw error;
      },
    });

    await actions.find((action) => action.id === "review:agent")?.run();

    expect(rpcValue).toBe(5);
    expect(receivedPaseo).toBe(runtime.paseo);
    expect(opened).toEqual(["review/surface/main", "review/agent/details/agent-1"]);
  });

  it("removes every contribution when its installation disappears", () => {
    expect(
      buildPluginCommandCenterContributions({
        plugins: [],
        runtime: createRuntime,
        state: stateSource(),
        workspaceId: workspace.id,
        agentId: agent.id,
        navigation: {
          openSurface() {},
          openWorkspacePanel() {},
          openAgentPanel() {},
        },
        reportError() {},
      }),
    ).toEqual([]);
  });
});
