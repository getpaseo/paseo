import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import { usePaseo, useRpc, useWorkspace, useWorkspaces } from "@getpaseo/plugin/client";
import { defineRpc } from "@getpaseo/plugin";
import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { QueryClient } from "@tanstack/react-query";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { z } from "zod";
import type { PluginWorkspaceSnapshot } from "@getpaseo/plugin";
import type { PluginClientStateSource } from "@getpaseo/plugin/client/host";
import type { ToastApi } from "@/components/toast-host";
import { PluginInstallationProvider } from "./installation-provider";
import { PluginEnvironmentProvider } from "./popover";
import type { InstalledPlugin } from "./types";

const status = defineRpc({
  name: "deploys.status",
  input: z.object({}),
  output: z.object({ state: z.string() }),
});

function installation(invoked: string[]): InstalledPlugin {
  return {
    id: "deploys",
    serverId: "host",
    clientBundle: "",
    lifetime: new AbortController(),
    locale: "en",
    i18n: new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} }),
    paseo: createPaseoApi(
      new DaemonClient({
        url: "ws://127.0.0.1:1",
        clientId: "installation-provider",
        reconnect: { enabled: false },
      }),
    ),
    invoke: async (method) => {
      invoked.push(method);
      return { state: "green" };
    },
    subscribe: () => {
      throw new Error("Subscriptions are not used here");
    },
    queryClient: new QueryClient(),
    cleanup: () => undefined,
    settingsScreens: [],
    surfaces: [],
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
    notificationOpenHandlers: [],
  };
}

it("gives every surface the installation's client and RPCs on its first frame", async () => {
  const invoked: string[] = [];
  const plugin = installation(invoked);
  const received: PaseoApi[] = [];
  let rpc: ((input: Record<string, never>) => Promise<unknown>) | null = null;
  function Surface({ name }: { name: string }) {
    received.push(usePaseo());
    rpc = useRpc(status);
    return <span>{name}</span>;
  }

  const markup = ["Screen", "Sidebar item", "Popover"]
    .map((name) =>
      renderToStaticMarkup(
        <PluginInstallationProvider plugin={plugin}>
          <Surface name={name} />
        </PluginInstallationProvider>,
      ),
    )
    .join("");

  expect(markup).toBe("<span>Screen</span><span>Sidebar item</span><span>Popover</span>");
  expect(received).toEqual([plugin.paseo, plugin.paseo, plugin.paseo]);
  expect(received.every((paseo) => paseo === plugin.paseo)).toBe(true);
  await expect(rpc!({})).resolves.toEqual({ state: "green" });
  expect(invoked).toEqual(["deploys.status"]);
  plugin.lifetime.abort();
  await plugin.paseo.dispose();
});

it("lets every surface read state through the plugin state hooks", async () => {
  const plugin = installation([]);
  function Surface() {
    return <span>{useWorkspaces().length} workspaces</span>;
  }

  const markup = renderToStaticMarkup(
    <PluginInstallationProvider plugin={plugin}>
      <Surface />
    </PluginInstallationProvider>,
  );

  expect(markup).toBe("<span>0 workspaces</span>");
  plugin.lifetime.abort();
  await plugin.paseo.dispose();
});

function pluginEnvironment(plugin: InstalledPlugin, state: PluginClientStateSource) {
  return { installation: plugin, state, toast: {} as ToastApi };
}

it("lets a surface read the state source its host passes", async () => {
  const plugin = installation([]);
  // A sidebar view spans every connected host, so its source is not the installation's host.
  const workspace = { id: "ws-on-another-host" } as PluginWorkspaceSnapshot;
  const state: PluginClientStateSource = {
    subscribe: () => () => undefined,
    getWorkspace: () => workspace,
    getAgent: () => null,
    getProject: () => null,
    getTerminal: () => null,
    getSnapshot: () => ({ workspaces: [], agents: [], projects: [], terminals: [] }),
  };
  function Surface() {
    return <span>{useWorkspace("ws-on-another-host")?.id}</span>;
  }

  const environment = pluginEnvironment(plugin, state);

  const markup = renderToStaticMarkup(
    <PluginEnvironmentProvider environment={environment}>
      <Surface />
    </PluginEnvironmentProvider>,
  );

  expect(markup).toBe("<span>ws-on-another-host</span>");
  plugin.lifetime.abort();
  await plugin.paseo.dispose();
});
