import { DAEMON_PERMISSIONS } from "@getpaseo/protocol/messages";
import pino from "pino";
import { describe, expect, test } from "vitest";
import { createAgentMcpServer } from "../mcp-server.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import type { BrowserToolsBroker } from "../../browser-tools/broker.js";
import type { ChangeRequestWatches } from "../change-request-watches/index.js";
import { createPaseoToolCatalog, type PaseoToolHostDependencies } from "./paseo-tools.js";

function createMinimalDeps(
  overrides: Partial<PaseoToolHostDependencies> = {},
): PaseoToolHostDependencies {
  const pluginTools = [
    {
      pluginId: "demo-plugin",
      pluginInstanceId: "inst-1",
      name: "demo_plugin_tool",
      title: "Demo plugin tool",
      description: "Contributed by plugin",
      inputSchema: { type: "object", properties: {} },
    },
  ];
  const agentManager = {
    getAgent: () => ({
      id: "agent-1",
      provider: "codex",
      cwd: "/tmp/repo",
      workspaceId: "ws-1",
      lifecycle: "idle",
      currentModeId: "default",
      availableModes: [],
      config: { title: "Test Agent" },
    }),
    getPluginTools: (agentId: string) => (agentId === "agent-1" ? pluginTools : []),
    executePluginTool: async () => ({ text: "ok" }),
  } as unknown as AgentManager;
  const agentStorage = {
    getAgent: async () => null,
    listAgents: async () => [],
  } as unknown as AgentStorage;
  const providerSnapshotManager = {
    getSnapshot: () => [],
  } as unknown as ProviderSnapshotManager;
  const browserToolsBroker = {
    listBrowserHosts: () => [],
    execute: async () => ({
      requestId: "req-1",
      ok: true,
      result: { command: "list_tabs", tabs: [] },
    }),
  } as unknown as BrowserToolsBroker;
  const changeRequestWatches = {
    subscribe: async () => ({}),
    unsubscribe: async () => ({ url: "", removed: true }),
  } as unknown as ChangeRequestWatches;

  return {
    agentManager,
    agentStorage,
    providerSnapshotManager,
    browserToolsBroker,
    changeRequestWatches,
    logger: pino({ level: "silent" }),
    ...overrides,
  };
}

describe("Paseo Tool Registry grouping, scope, and permission metadata", () => {
  test("every registered tool declares a valid group, scope, and semantic permission", () => {
    const validPermissions = new Set<string>(DAEMON_PERMISSIONS);
    const catalog = createPaseoToolCatalog(
      createMinimalDeps({
        callerAgentId: "agent-1",
        enableVoiceTools: true,
        toolsConfig: {
          enabled: true,
          groups: {
            orchestration: true,
            schedules: true,
            changeRequests: true,
            browser: true,
          },
        },
      }),
    );

    expect(catalog.tools.size).toBeGreaterThan(45);
    for (const tool of catalog.tools.values()) {
      expect([
        "orchestration",
        "schedules",
        "changeRequests",
        "browser",
        "voice",
        "plugin",
      ]).toContain(tool.group);
      expect(["agent", "top-level", "both"]).toContain(tool.scope);
      expect(validPermissions.has(tool.permission)).toBe(true);
    }

    expect(catalog.getTool("create_agent")).toMatchObject({
      group: "orchestration",
      scope: "both",
      permission: "workspace.write",
    });
    expect(catalog.getTool("list_agents")).toMatchObject({
      group: "orchestration",
      scope: "both",
      permission: "workspace.read",
    });
    expect(catalog.getTool("list_hosts")).toMatchObject({
      group: "orchestration",
      scope: "both",
      permission: "daemon.read",
    });
    expect(catalog.getTool("create_schedule")).toMatchObject({
      group: "schedules",
      scope: "both",
      permission: "automation.manage",
    });
    expect(catalog.getTool("create_heartbeat")).toMatchObject({
      group: "schedules",
      scope: "agent",
      permission: "automation.manage",
    });
    expect(catalog.getTool("subscribe_change_request")).toMatchObject({
      group: "changeRequests",
      scope: "agent",
      permission: "workspace.read",
    });
    expect(catalog.getTool("browser_list_tabs")).toMatchObject({
      group: "browser",
      scope: "agent",
      permission: "workspace.read",
    });
    expect(catalog.getTool("browser_click")).toMatchObject({
      group: "browser",
      scope: "agent",
      permission: "workspace.write",
    });
    expect(catalog.getTool("speak")).toMatchObject({
      group: "voice",
      scope: "agent",
      permission: "workspace.write",
    });
    expect(catalog.getTool("demo_plugin_tool")).toMatchObject({
      group: "plugin",
      scope: "agent",
      permission: "workspace.write",
    });
  });

  test("filters built-in groups consistently in both native catalog and MCP server adapter", async () => {
    const deps = createMinimalDeps({
      callerAgentId: "agent-1",
      toolsConfig: {
        enabled: true,
        groups: {
          orchestration: false,
          schedules: true,
          changeRequests: false,
          browser: false,
        },
      },
    });
    const catalog = createPaseoToolCatalog(deps);
    const mcpServer = await createAgentMcpServer(deps);
    const mcpRegisteredNames = Object.keys(
      (mcpServer as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    ).sort();

    expect([...catalog.tools.keys()].sort()).toEqual(mcpRegisteredNames);
    expect(catalog.getTool("list_agents")).toBeUndefined();
    expect(catalog.getTool("subscribe_change_request")).toBeUndefined();
    expect(catalog.getTool("browser_list_tabs")).toBeUndefined();
    expect(catalog.getTool("create_schedule")).toBeDefined();
    expect(catalog.getTool("create_heartbeat")).toBeDefined();
    expect(catalog.getTool("demo_plugin_tool")).toBeDefined();
  });

  test("keeps voice speak tool and plugin tools available when all built-in groups are disabled", () => {
    const catalog = createPaseoToolCatalog(
      createMinimalDeps({
        callerAgentId: "agent-1",
        enableVoiceTools: true,
        toolsConfig: {
          enabled: true,
          groups: {
            orchestration: false,
            schedules: false,
            changeRequests: false,
            browser: false,
          },
        },
      }),
    );

    expect([...catalog.tools.keys()].sort()).toEqual(["demo_plugin_tool", "speak"]);
  });

  test("omits all agent tools including speak and plugin tools when master tools.enabled is false", () => {
    const catalog = createPaseoToolCatalog(
      createMinimalDeps({
        callerAgentId: "agent-1",
        enableVoiceTools: true,
        toolsConfig: {
          enabled: false,
          groups: {
            orchestration: true,
            schedules: true,
            changeRequests: true,
            browser: true,
          },
        },
      }),
    );

    expect([...catalog.tools.keys()]).toEqual([]);
  });

  test("top-level catalog excludes agent-only tools and supports permission filtering for external MCP", () => {
    const fullTopLevel = createPaseoToolCatalog(
      createMinimalDeps({
        enableVoiceTools: true,
        toolsConfig: {
          enabled: true,
          groups: {
            orchestration: true,
            schedules: true,
            changeRequests: true,
            browser: true,
          },
        },
      }),
    );

    expect(fullTopLevel.getTool("list_agents")).toBeDefined();
    expect(fullTopLevel.getTool("create_schedule")).toBeDefined();
    expect(fullTopLevel.getTool("create_heartbeat")).toBeUndefined();
    expect(fullTopLevel.getTool("delete_heartbeat")).toBeUndefined();
    expect(fullTopLevel.getTool("subscribe_change_request")).toBeUndefined();
    expect(fullTopLevel.getTool("unsubscribe_change_request")).toBeUndefined();
    expect(fullTopLevel.getTool("browser_list_tabs")).toBeUndefined();
    expect(fullTopLevel.getTool("speak")).toBeUndefined();
    expect(fullTopLevel.getTool("demo_plugin_tool")).toBeUndefined();

    const readOnlyTopLevel = createPaseoToolCatalog(
      createMinimalDeps({
        toolsConfig: {
          enabled: true,
          groups: {
            orchestration: true,
            schedules: true,
            changeRequests: true,
            browser: true,
          },
        },
        allowedPermissions: new Set(["daemon.read", "workspace.read"]),
      }),
    );

    expect(readOnlyTopLevel.getTool("list_hosts")).toBeDefined();
    expect(readOnlyTopLevel.getTool("list_agents")).toBeDefined();
    expect(readOnlyTopLevel.getTool("create_agent")).toBeUndefined();
    expect(readOnlyTopLevel.getTool("create_workspace")).toBeUndefined();
    expect(readOnlyTopLevel.getTool("create_schedule")).toBeUndefined();
    for (const tool of readOnlyTopLevel.tools.values()) {
      expect(["daemon.read", "workspace.read"]).toContain(tool.permission);
    }
  });
});
