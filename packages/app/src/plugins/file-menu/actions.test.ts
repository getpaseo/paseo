import { QueryClient } from "@tanstack/react-query";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginWorkspaceSnapshot } from "@getpaseo/plugin";
import type {
  PluginFileMenuContext,
  PluginFileMenuItemContribution,
} from "@getpaseo/plugin/client";
import { describe, expect, it } from "vitest";
import type { PluginNavigation } from "../actions";
import type { InstalledPlugin } from "../types";
import { buildPluginFileMenuActions, type PluginFileMenuSource } from "./actions";

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

function plugin(
  onSelect: PluginFileMenuItemContribution["onSelect"],
  overrides: Partial<InstalledPlugin> = {},
): InstalledPlugin {
  return {
    id: "reader",
    serverId: "host-1",
    clientBundle: "bundle",
    lifetime: new AbortController(),
    queryClient: new QueryClient(),
    cleanup: () => {},
    settingsScreens: [],
    surfaces: [],
    sidebarItems: [],
    workspacePanels: [
      {
        id: "view",
        title: "View",
        icon: "Scan",
        context: "workspace",
        locations: ["workspace"],
        Component: () => null,
      },
      {
        id: "agent-view",
        title: "Agent",
        icon: "Scan",
        context: "agent",
        locations: ["workspace"],
        Component: () => null,
      },
    ],
    commandCenterItems: [],
    fileMenuItems: [{ id: "open", title: "Open in Reader", icon: "Scan", onSelect }],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
    ...overrides,
  };
}

function harness(plugins: InstalledPlugin[], overrides: Partial<PluginFileMenuSource> = {}) {
  const errors: string[] = [];
  const opened: string[] = [];
  let runtimes = 0;
  let disposed = 0;
  const navigation: PluginNavigation = {
    openSettings() {},
    openSurface() {},
    openWorkspacePanel(pluginId, panelId, location) {
      opened.push(`${pluginId}/${panelId}/${location}`);
    },
    openAgentPanel() {},
  };
  const source: PluginFileMenuSource = {
    serverId: "host-1",
    workspaceId: workspace.id,
    file: { path: "src/app.ts" },
    plugins,
    runtime() {
      runtimes += 1;
      // The file menu never uses the API itself; it only owns disposal of the per-selection runtime.
      const paseo = {
        async dispose() {
          disposed += 1;
        },
      } as unknown as PaseoApi;
      return { paseo, invoke: async () => undefined };
    },
    state: {
      subscribe: () => () => {},
      getWorkspace: (id) => (id === workspace.id ? workspace : null),
      getAgent: () => null,
    },
    navigation,
    reportError(error) {
      errors.push(error instanceof Error ? error.message : String(error));
    },
    ...overrides,
  };
  return {
    actions: () => buildPluginFileMenuActions(source),
    errors,
    opened,
    counts: () => ({ runtimes, disposed }),
  };
}

describe("plugin file menu actions", () => {
  it("lists only this host's items for workspace-relative paths", () => {
    const local = plugin(() => {});
    const remote = plugin(() => {}, { id: "remote", serverId: "host-2" });
    expect(
      harness([local, remote])
        .actions()
        .map((action) => [action.key, action.label]),
    ).toEqual([["reader-open", "Open in Reader"]]);
    for (const path of [
      "",
      "/etc/passwd",
      "../outside.ts",
      "src//app.ts",
      "src/./app.ts",
      "C:/app.ts",
    ]) {
      expect(harness([local], { file: { path } }).actions()).toEqual([]);
    }
  });

  it("runs with the workspace snapshot and file, opens a workspace panel, then disposes the runtime", async () => {
    let received: PluginFileMenuContext | null = null;
    const installed = plugin((context) => {
      received = context;
      context.openPanel("view");
    });
    const test = harness([installed]);
    await test.actions()[0]?.run();

    expect(received).not.toBeNull();
    const context = received as unknown as PluginFileMenuContext;
    expect(context.context).toBe("workspace");
    expect(context.workspace).toBe(workspace);
    expect(context.file).toEqual({ path: "src/app.ts" });
    expect(Object.isFrozen(context.file)).toBe(true);
    expect(() => context.openPanel("agent-view")).toThrow(
      "Workspace panel is unavailable: agent-view",
    );
    expect(test.opened).toEqual(["reader/view/workspace"]);
    expect(test.errors).toEqual([]);
    expect(test.counts()).toEqual({ runtimes: 1, disposed: 1 });
  });

  it("reports a failing callback and still disposes its runtime", async () => {
    const test = harness([
      plugin(async () => {
        throw new Error("Reader failed");
      }),
    ]);
    await test.actions()[0]?.run();
    expect(test.errors).toEqual(["Reader failed"]);
    expect(test.counts()).toEqual({ runtimes: 1, disposed: 1 });
  });

  it("reports an offline host or missing workspace without calling the plugin", async () => {
    let calls = 0;
    const installed = plugin(() => {
      calls += 1;
    });
    const offline = harness([installed], { runtime: () => null });
    await offline.actions()[0]?.run();
    expect(offline.errors).toEqual(["Plugin host is offline"]);

    const missing = harness([installed], { workspaceId: "workspace-gone" });
    await missing.actions()[0]?.run();
    expect(missing.errors).toEqual(["Workspace is unavailable"]);
    expect(missing.counts()).toEqual({ runtimes: 1, disposed: 1 });
    expect(calls).toBe(0);
  });

  it("does not run an item after its plugin unloads", async () => {
    let calls = 0;
    const installed = plugin(() => {
      calls += 1;
    });
    const test = harness([installed]);
    const [action] = test.actions();
    installed.lifetime.abort();
    await action?.run();
    expect(calls).toBe(0);
    expect(test.errors).toEqual(["Plugin reader is no longer loaded"]);
    expect(test.counts().runtimes).toBe(0);
    expect(harness([installed]).actions()).toEqual([]);
  });

  it("does not run an item whose registration was removed while the plugin stays loaded", async () => {
    let calls = 0;
    const installed = plugin(() => {
      calls += 1;
    });
    const test = harness([installed]);
    const [action] = test.actions();
    installed.fileMenuItems.splice(0, 1);
    await action?.run();
    expect(calls).toBe(0);
    expect(installed.lifetime.signal.aborted).toBe(false);
    expect(test.errors).toEqual(["File menu item reader/open is no longer available"]);
    expect(test.counts().runtimes).toBe(0);
  });

  it("refuses late navigation once the item or plugin is gone", async () => {
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const installed = plugin(async (context) => {
      await paused;
      context.openPanel("view");
    });
    const test = harness([installed]);
    const running = test.actions()[0]?.run();
    installed.fileMenuItems.splice(0, 1);
    resume();
    await running;
    expect(test.opened).toEqual([]);
    expect(test.errors).toEqual(["File menu item reader/open is no longer available"]);
    expect(test.counts()).toEqual({ runtimes: 1, disposed: 1 });
  });
});
