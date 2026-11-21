/** @vitest-environment jsdom */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import { QueryClient } from "@tanstack/react-query";
import type { InstalledPlugin } from "../types";
import { pluginButtonStore } from "./store";
import { PluginComposerPills } from "./view";

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({}),
  useHosts: () => [{ serverId: "host", label: "Host" }],
}));
vi.mock("../client-state/source", () => ({ createPluginClientStateSource: () => ({}) }));
vi.mock("../icons", () => ({
  parsePluginIcon: (_name: string, icon: string) => icon,
  pluginIconComponent: () => () => null,
}));
vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error() {} }),
  ToastApiProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../popover", async () => {
  const reactModule = await import("react");
  const { useMenuContext } = await import("@/components/ui/menu");
  return {
    PluginEnvironmentProvider: ({ children }: { children: React.ReactNode }) => children,
    PluginPopoverContent: ({ children }: { children: React.ReactNode }) => children,
    PluginPopoverSurface: () => {
      const menu = useMenuContext("test");
      return menu.open ? reactModule.createElement("div", { role: "dialog" }, "Agent steps") : null;
    },
  };
});

beforeEach(() => vi.stubGlobal("React", React));

it("opens only the composer pill that was pressed when the same agent has two views", () => {
  const plugin = {
    serverId: "host",
    i18n: new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} }),
    queryClient: new QueryClient(),
  } as InstalledPlugin;
  const registration = pluginButtonStore.addComposerPill(plugin, {
    id: "steps",
    workspaceId: "workspace",
    agentId: "agent",
    button: {
      title: "Agent steps",
      icon: "Scan",
      behavior: { kind: "popover", Content: () => null },
    },
  });
  const view = (
    <PluginComposerPills serverId="host" workspaceId="workspace" agentId="agent" compact />
  );
  const mounted = render(
    <>
      {view}
      {view}
    </>,
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Agent steps" })[0]);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(
    screen
      .getAllByRole("button", { name: "Agent steps" })
      .map((button) => button.getAttribute("aria-expanded")),
  ).toEqual(["true", "false"]);
  fireEvent.click(screen.getAllByRole("button", { name: "Agent steps" })[1]);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(
    screen
      .getAllByRole("button", { name: "Agent steps" })
      .map((button) => button.getAttribute("aria-expanded")),
  ).toEqual(["false", "true"]);
  act(() => registration.update({ disabled: true }));
  expect(screen.queryAllByRole("dialog")).toHaveLength(0);
  mounted.unmount();
  registration.remove();
  plugin.i18n.dispose();
});
