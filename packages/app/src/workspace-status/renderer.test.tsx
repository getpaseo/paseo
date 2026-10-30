/** @vitest-environment jsdom */
import React, { useEffect } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import { usePaseo, type PluginWorkspaceStatusRendererProps } from "@getpaseo/plugin/client";
import type { PaseoApi } from "@getpaseo/client";
import type { InstalledPlugin } from "@/plugins/types";
import type { SidebarWorkspaceEntry } from "@/hooks/sidebar-workspaces-view-model";
import { WorkspaceStatusRenderer } from "./renderer";

let installed: InstalledPlugin[] = [];
vi.mock("@/plugins/registry", () => ({ useInstalledPlugins: () => installed }));
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [
    { serverId: "a", label: "Host A" },
    { serverId: "b", label: "Host B" },
  ],
}));
vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => false,
  isCompactBreakpoint: () => false,
}));
vi.mock("react-native-unistyles", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-native-unistyles")>();
  return {
    ...original,
    withUnistyles: (Component: React.ComponentType<Record<string, unknown>>) =>
      function Themed({
        uniProps,
        ...props
      }: {
        uniProps?: (theme: unknown, rt: object) => object;
      }) {
        return React.createElement(Component, {
          ...props,
          ...uniProps?.(original.useUnistyles().theme, {}),
        });
      },
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  installed = [];
});

function installation(
  serverId: string,
  Component: React.ComponentType<PluginWorkspaceStatusRendererProps>,
): InstalledPlugin {
  return {
    id: "rings",
    serverId,
    clientBundle: "",
    lifetime: new AbortController(),
    locale: "en",
    i18n: new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} }),
    paseo: { dispose: async () => undefined } as PaseoApi,
    invoke: vi.fn(async () => ({})),
    queryClient: new QueryClient(),
    cleanup() {},
    surfaces: [],
    settingsScreens: [],
    sidebarItems: { header: [], footer: [] },
    legacySidebarItems: [],
    filePanels: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    providerIconOverrides: [],
    floatingWidgets: [],
    workspaceStatusRenderers: [{ id: "ring", Component }],
    timelineTransformers: [],
    timelineRenderers: [],
  };
}

const workspace = {
  serverId: "a",
  workspaceId: "w",
  name: "Workspace",
  statusBucket: "running",
} as SidebarWorkspaceEntry;

it("uses only the owning host installation and restores the default on unload", () => {
  let seen: PaseoApi | null = null;
  let unmounted = 0;
  function Rings(props: PluginWorkspaceStatusRendererProps) {
    seen = usePaseo();
    useEffect(
      () => () => {
        unmounted += 1;
      },
      [],
    );
    return (
      <span>{`${props.host.label}:${props.statusDetails === null ? "unknown" : "known"}:${props.activities === null ? "unknown" : "known"}`}</span>
    );
  }
  const a = installation("a", Rings);
  installed = [installation("b", () => <span>wrong host</span>), a];
  const view = render(
    <WorkspaceStatusRenderer workspace={workspace} loading={false}>
      <span>default</span>
    </WorkspaceStatusRenderer>,
  );
  expect(screen.getByText("Host A:unknown:unknown")).not.toBeNull();
  expect(seen).toBe(a.paseo);
  expect(screen.queryByText("wrong host")).toBeNull();
  installed = [];
  view.rerender(
    <WorkspaceStatusRenderer workspace={workspace} loading={false}>
      <span>default</span>
    </WorkspaceStatusRenderer>,
  );
  expect(screen.getByText("default")).not.toBeNull();
  expect(unmounted).toBe(1);
});

it("falls back after renderer failure and recovers when the installation is replaced", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  installed = [
    installation("a", () => {
      throw new Error("bad renderer");
    }),
  ];
  const view = render(
    <WorkspaceStatusRenderer workspace={workspace} loading={false}>
      <span>default</span>
    </WorkspaceStatusRenderer>,
  );
  expect(screen.getByText("default")).not.toBeNull();
  installed = [installation("a", () => <span>recovered</span>)];
  view.rerender(
    <WorkspaceStatusRenderer workspace={workspace} loading={false}>
      <span>default</span>
    </WorkspaceStatusRenderer>,
  );
  expect(screen.getByText("recovered")).not.toBeNull();
});
