/**
 * @vitest-environment jsdom
 */
import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import { QueryClient } from "@tanstack/react-query";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Text } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "../types";

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
}));

vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => false,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({}),
  useHosts: () => [{ serverId: "host-a", label: "Local" }],
}));

vi.mock("../client-state/source", () => ({
  createPluginClientStateSource: () => ({}),
}));

vi.mock("../installation-provider", () => ({
  PluginInstallationProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/contexts/toast-context", () => ({
  ToastApiProvider: ({ children }: { children: React.ReactNode }) => children,
  useToast: () => ({ show: vi.fn(), error: vi.fn() }),
}));

vi.mock("react-native-reanimated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-native-reanimated")>()),
  default: {
    View: ({
      children,
      role,
      testID,
    }: {
      children?: React.ReactNode;
      role?: string;
      testID?: string;
    }) => React.createElement("div", { role, "data-testid": testID }, children),
  },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));

vi.mock("../icons", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../icons")>()),
  pluginIconComponent: () => () => null,
}));

import { pluginButtonStore } from "./store";
import { PluginComposerPills } from "./view";

function createInstallation(): InstalledPlugin {
  return {
    lifetime: new AbortController(),
    locale: "en",
    i18n: new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} }),
    id: "better-paseo",
    serverId: "host-a",
    clientBundle: "bundle",
    queryClient: new QueryClient(),
    paseo: {} as InstalledPlugin["paseo"],
    invoke: async () => undefined,
    subscribe: () => {
      throw new Error("Subscriptions are not used here");
    },
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
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let removePill: (() => void) | null = null;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container?.remove();
  container = null;
  removePill?.();
  removePill = null;
  document.getElementById("overlay-root")?.remove();
  vi.unstubAllGlobals();
});

describe("PluginComposerPills", () => {
  it("hides the tooltip when the pill opens its popover and keeps it hidden while open", async () => {
    const registration = pluginButtonStore.addComposerPill(createInstallation(), {
      id: "agent-steps",
      workspaceId: "workspace",
      agentId: "agent",
      button: {
        title: "Agent steps",
        label: "Standard",
        icon: () => null,
        behavior: {
          kind: "popover",
          Content: () => <Text testID="popover-body">Popover menu</Text>,
        },
      },
    });
    removePill = registration.remove;

    await act(async () => {
      root?.render(
        <PluginComposerPills
          serverId="host-a"
          workspaceId="workspace"
          agentId="agent"
          compact={false}
        />,
      );
      await Promise.resolve();
    });

    const trigger = container?.querySelector('[aria-label="Agent steps"]');
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
      await Promise.resolve();
    });
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(document.querySelector('[data-testid="popover-body"]')).not.toBeNull();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
      await Promise.resolve();
    });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
});
