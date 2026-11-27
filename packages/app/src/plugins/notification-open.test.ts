import { QueryClient } from "@tanstack/react-query";
import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginNotificationOpenHandler } from "@getpaseo/plugin/client";
import { describe, expect, it } from "vitest";
import {
  openPluginNotification,
  type PluginNotificationOpenRegistry,
  type PluginNotificationTarget,
} from "./notification-open";
import type { PluginCatalogStatus } from "./registry";
import type { InstalledPlugin } from "./types";

class FakePluginRegistry implements PluginNotificationOpenRegistry {
  private plugins: InstalledPlugin[] = [];
  private statuses = new Map<string, PluginCatalogStatus>();
  private listeners = new Set<() => void>();

  getSnapshot(): readonly InstalledPlugin[] {
    return this.plugins;
  }

  getCatalogStatus(serverId: string): PluginCatalogStatus {
    return this.statuses.get(serverId) ?? "loading";
  }

  setCatalogStatus(serverId: string, status: PluginCatalogStatus): void {
    this.statuses.set(serverId, status);
    this.notify();
  }

  install(plugin: InstalledPlugin): void {
    this.plugins = [
      ...this.plugins.filter((p) => !(p.serverId === plugin.serverId && p.id === plugin.id)),
      plugin,
    ];
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function makeInstalledPlugin(input: {
  serverId: string;
  pluginId: string;
  screens?: string[];
  handlers?: PluginNotificationOpenHandler[];
}): InstalledPlugin {
  return {
    id: input.pluginId,
    serverId: input.serverId,
    lifetime: new AbortController(),
    locale: "en",
    i18n: new PluginTranslationRuntime({
      getLocale: () => "en",
      subscribe: () => () => {},
    }),
    paseo: createPaseoApi(
      new DaemonClient({
        url: "ws://127.0.0.1:1",
        clientId: `plugin-notification-test-${input.pluginId}`,
        clientType: "cli",
      }),
    ),
    invoke: async () => undefined,
    subscribe: () => {
      throw new Error("not used");
    },
    clientBundle: "",
    queryClient: new QueryClient(),
    cleanup: () => {},
    surfaces: (input.screens ?? ["main"]).map((id) => ({
      id,
      title: id,
      Component: () => null,
    })),
    settingsScreens: [],
    sidebarViews: [],
    sidebarItems: { header: [], footer: [] },
    legacySidebarItems: [],
    workspaceRowBadgeItems: [],
    filePanels: [],
    composerItems: [],
    newWorkspaceItems: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
    notificationOpenHandlers: input.handlers ?? [],
    forgeClientProviders: [],
  };
}

function createHarness(registry = new FakePluginRegistry()) {
  const agents: Array<{ serverId: string; agentId: string }> = [];
  const workspaces: Array<{ serverId: string; workspaceId: string }> = [];
  const routes: string[] = [];
  const focusedHosts: string[] = [];
  const errors: Array<{ error: unknown; serverId: string; pluginId: string }> = [];

  return {
    registry,
    agents,
    workspaces,
    routes,
    focusedHosts,
    errors,
    dispatch: (target: PluginNotificationTarget, timeoutMs = 100) =>
      openPluginNotification(target, {
        registry,
        timeoutMs,
        openAgent: (item) => {
          agents.push(item);
          return `/h/${item.serverId}/agent/${item.agentId}`;
        },
        openWorkspace: (item) => {
          workspaces.push(item);
          return `/h/${item.serverId}/workspace/${item.workspaceId}`;
        },
        openRoute: (route) => {
          routes.push(route);
        },
        focusHost: (serverId) => {
          focusedHosts.push(serverId);
        },
        onError: (error, context) => {
          errors.push({ error, ...context });
        },
      }),
  };
}

describe("openPluginNotification", () => {
  it("invokes onNotificationOpen immediately on warm tap when plugin is already installed", async () => {
    const harness = createHarness();
    const receivedEvents: unknown[] = [];

    harness.registry.setCatalogStatus("srv-1", "ready");
    harness.registry.install(
      makeInstalledPlugin({
        serverId: "srv-1",
        pluginId: "ci-alerts",
        screens: ["report"],
        handlers: [
          ({ event, openScreen, navigation }) => {
            receivedEvents.push(event);
            if (typeof event.data?.agentId === "string") {
              navigation.openAgent({ agentId: event.data.agentId, focusHost: true });
            } else {
              openScreen({
                screenId: "report",
                params: { buildId: String(event.data?.buildId ?? "") },
              });
            }
          },
        ],
      }),
    );

    await harness.dispatch({
      kind: "plugin",
      serverId: "srv-1",
      pluginId: "ci-alerts",
      notificationId: "notif-42",
      open: { type: "workspace", workspaceId: "ws-ignored-because-handler-ran" },
      data: { buildId: 42 },
    });

    expect(receivedEvents).toEqual([
      {
        type: "opened",
        notificationId: "notif-42",
        data: { buildId: 42 },
      },
    ]);
    expect(harness.routes).toEqual(["/h/srv-1/plugin/ci-alerts/surface/report?param.buildId=42"]);
    expect(harness.workspaces).toEqual([]);
  });

  it("waits for plugin catalog readiness on cold launch before invoking onNotificationOpen", async () => {
    const harness = createHarness();
    // Catalog is still "loading" on cold launch
    expect(harness.registry.getCatalogStatus("srv-1")).toBe("loading");

    const pending = harness.dispatch(
      {
        kind: "plugin",
        serverId: "srv-1",
        pluginId: "ci-alerts",
        notificationId: "notif-cold",
        data: { agentId: "agent-99" },
      },
      1_000,
    );

    // Nothing dispatched while catalog is still loading
    await Promise.resolve();
    expect(harness.agents).toEqual([]);

    // Catalog finishes loading and installs the plugin
    harness.registry.install(
      makeInstalledPlugin({
        serverId: "srv-1",
        pluginId: "ci-alerts",
        handlers: [
          ({ event, navigation }) => {
            if (typeof event.data?.agentId === "string") {
              navigation.openAgent({ agentId: event.data.agentId, focusHost: true });
            }
          },
        ],
      }),
    );
    harness.registry.setCatalogStatus("srv-1", "ready");

    await pending;
    expect(harness.agents).toEqual([{ serverId: "srv-1", agentId: "agent-99" }]);
    expect(harness.focusedHosts).toEqual(["srv-1"]);
  });

  it("falls back to declarative open targets (agent, workspace, screen, host root) when no handler is registered or catalog times out", async () => {
    const harness = createHarness();
    harness.registry.setCatalogStatus("srv-1", "ready");
    harness.registry.install(
      makeInstalledPlugin({
        serverId: "srv-1",
        pluginId: "declarative-plugin",
        screens: ["details"],
        handlers: [],
      }),
    );

    await harness.dispatch({
      kind: "plugin",
      serverId: "srv-1",
      pluginId: "declarative-plugin",
      notificationId: "n-agent",
      open: { type: "agent", agentId: "agent-1" },
    });
    expect(harness.agents).toEqual([{ serverId: "srv-1", agentId: "agent-1" }]);

    await harness.dispatch({
      kind: "plugin",
      serverId: "srv-1",
      pluginId: "declarative-plugin",
      notificationId: "n-workspace",
      open: { type: "workspace", workspaceId: "ws-1" },
    });
    expect(harness.workspaces).toEqual([{ serverId: "srv-1", workspaceId: "ws-1" }]);

    await harness.dispatch({
      kind: "plugin",
      serverId: "srv-1",
      pluginId: "declarative-plugin",
      notificationId: "n-screen",
      open: { type: "screen", screenId: "details", params: { tab: "logs" } },
    });
    expect(harness.routes).toEqual([
      "/h/srv-1/plugin/declarative-plugin/surface/details?param.tab=logs",
    ]);

    // Timeout waiting for an offline host catalog falls back to declarative open or host root
    await harness.dispatch(
      {
        kind: "plugin",
        serverId: "srv-loading",
        pluginId: "missing-plugin",
        notificationId: "n-host",
      },
      10,
    );
    expect(harness.routes).toEqual([
      "/h/srv-1/plugin/declarative-plugin/surface/details?param.tab=logs",
      "/h/srv-loading",
    ]);
  });

  it("catches and reports errors thrown by onNotificationOpen handlers without crashing", async () => {
    const harness = createHarness();
    harness.registry.setCatalogStatus("srv-1", "ready");
    harness.registry.install(
      makeInstalledPlugin({
        serverId: "srv-1",
        pluginId: "buggy-plugin",
        screens: ["main"],
        handlers: [
          () => {
            throw new Error("boom in first handler");
          },
          ({ openScreen }) => {
            openScreen({ screenId: "main" });
          },
        ],
      }),
    );

    await harness.dispatch({
      kind: "plugin",
      serverId: "srv-1",
      pluginId: "buggy-plugin",
      notificationId: "n-err",
    });

    expect(harness.errors).toHaveLength(1);
    expect(harness.routes).toEqual(["/h/srv-1/plugin/buggy-plugin/surface/main"]);
  });

  it("falls back to declarative open when every registered onNotificationOpen handler throws", async () => {
    const harness = createHarness();
    harness.registry.setCatalogStatus("srv-1", "ready");
    harness.registry.install(
      makeInstalledPlugin({
        serverId: "srv-1",
        pluginId: "failing-plugin",
        handlers: [
          () => {
            throw new Error("handler boom");
          },
        ],
      }),
    );

    await harness.dispatch({
      kind: "plugin",
      serverId: "srv-1",
      pluginId: "failing-plugin",
      notificationId: "n-throw-fallback",
      open: { type: "agent", agentId: "agent-fallback" },
    });

    expect(harness.errors).toHaveLength(1);
    expect(harness.agents).toEqual([{ serverId: "srv-1", agentId: "agent-fallback" }]);
  });
});
