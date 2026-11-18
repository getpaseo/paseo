import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import { usePaseo, useComposers, type PluginComposerSectionProps } from "@getpaseo/plugin/client";
import { QueryClient } from "@tanstack/react-query";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import type { InstalledPlugin } from "./types";
import { PluginComposerSections } from "./composer-sections";

const catalog = vi.hoisted<{ plugins: InstalledPlugin[] }>(() => ({ plugins: [] }));
vi.mock("./registry", () => ({ useInstalledPlugins: () => catalog.plugins }));

function Section({ agentId, workspaceId, host }: PluginComposerSectionProps) {
  const api = usePaseo();
  const composers = useComposers({ agentId });
  expect(typeof api.agents.ref).toBe("function");
  expect(composers).toEqual([]);
  return (
    <span>
      {host.id}/{workspaceId}/{agentId}
    </span>
  );
}

function installation(serverId: string): InstalledPlugin {
  return {
    id: "replies",
    serverId,
    clientBundle: "",
    lifetime: new AbortController(),
    locale: "en",
    i18n: new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} }),
    paseo: createPaseoApi(
      new DaemonClient({
        url: "ws://127.0.0.1:1",
        clientId: "sections-test",
        reconnect: { enabled: false },
      }),
    ),
    invoke: async () => undefined,
    subscribe: () => {
      throw new Error("No subscriptions in this test");
    },
    queryClient: new QueryClient(),
    cleanup: () => {},
    surfaces: [],
    settingsScreens: [],
    sidebarViews: [],
    sidebarItems: { header: [], footer: [] },
    legacySidebarItems: [],
    filePanels: [],
    composerItems: [],
    composerSections: [{ id: "suggestions", Component: Section }],
    newWorkspaceItems: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
  };
}

const toast = { show: () => () => {}, copied() {}, error() {} };

function render(agentId: string) {
  return renderToStaticMarkup(
    <ToastApiProvider api={toast}>
      <PluginComposerSections serverId="host-a" workspaceId="workspace" agentId={agentId} />
    </ToastApiProvider>,
  );
}

describe("composer sections", () => {
  it("scopes sections to the composer host and supplies the current agent with installation hooks", async () => {
    const first = installation("host-a");
    const other = installation("host-b");
    catalog.plugins = [first, other];
    expect(render("first")).toBe("<span>host-a/workspace/first</span>");
    expect(render("second")).toBe("<span>host-a/workspace/second</span>");
    catalog.plugins = [other];
    expect(render("second")).toBe("");
    await first.paseo.dispose();
    await other.paseo.dispose();
  });
  it("adds no title, button, or spacer when a section returns null", async () => {
    const plugin = installation("host-a");
    plugin.composerSections[0].Component = () => null;
    catalog.plugins = [plugin];
    expect(render("agent")).toBe("");
    await plugin.paseo.dispose();
  });
});
