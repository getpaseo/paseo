/**
 * @vitest-environment jsdom
 */
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginButton } from "@getpaseo/plugin/client";
import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import { QueryClient } from "@tanstack/react-query";
import React, { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "../types";

const daemonClient = vi.hoisted(() => ({}) as DaemonClient);

vi.mock("@/runtime/host-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/runtime/host-runtime")>()),
  useHostRuntimeClient: () => daemonClient,
  useHosts: () => [{ serverId: "host-1", label: "Local" }],
}));
vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => false,
}));
vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }),
}));
vi.mock("../icons", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../icons")>()),
  Icon: () => null,
  PluginIconView: () => null,
  pluginIconComponent: () => () => null,
}));
vi.mock("../popover", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../popover")>()),
  PluginEnvironmentProvider: ({ children }: { children: ReactNode }) => children,
  PluginPopoverContent: () => null,
  PluginPopoverSurface: () => null,
}));
vi.mock("@/components/ui/tooltip", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/tooltip")>()),
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
}));
vi.mock("@/components/ui/menu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/menu")>()),
  MenuRoot: ({ children }: { children: ReactNode }) => children,
  MenuTrigger: ({
    accessibilityLabel,
    style,
    children,
  }: {
    accessibilityLabel?: string;
    style?: ((state: { hovered?: boolean; pressed: boolean }) => unknown) | unknown;
    children?: ReactNode;
  }) => {
    const resolved =
      typeof style === "function" ? style({ hovered: false, pressed: false }) : style;
    const flat = Object.assign(
      {},
      ...(Array.isArray(resolved) ? resolved.flat(Infinity).filter(Boolean) : [resolved]),
    );
    return (
      <button
        type="button"
        aria-label={accessibilityLabel}
        data-max-width={String(flat.maxWidth ?? "")}
        data-flex-shrink={String(flat.flexShrink ?? "")}
        data-min-width={String(flat.minWidth ?? "")}
      >
        {children}
      </button>
    );
  },
  MenuItem: () => null,
  MenuSeparator: () => null,
  MenuSubTrigger: () => null,
  useMenuContext: () => ({ setOpen: vi.fn() }),
}));

import { pluginButtonStore } from "./store";
import {
  PLUGIN_COMPOSER_PILL_MAX_WIDTH,
  PLUGIN_HEADER_BUTTON_MAX_WIDTH,
  PluginComposerPills,
  PluginHeaderButtons,
} from "./view";

function installation(): InstalledPlugin {
  return {
    lifetime: new AbortController(),
    locale: "en",
    i18n: new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} }),
    id: "live-usage",
    serverId: "host-1",
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

function popoverButton(title: string, label: string): PluginButton {
  return {
    title,
    label,
    icon: "Gauge",
    behavior: { kind: "popover", Content: () => null },
  };
}

describe("Plugin button max widths", () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];
  const containers: HTMLElement[] = [];
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    for (const container of containers.splice(0)) container.remove();
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function render(node: ReactNode): HTMLElement {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(node));
    return container;
  }

  it("gives composer pills a wider maxWidth than header buttons while preserving flex shrink", () => {
    const plugin = installation();
    const pillHandle = pluginButtonStore.addComposerPill(plugin, {
      id: "usage-pill",
      workspaceId: "ws-1",
      agentId: "agent-1",
      button: popoverButton("Live Usage", "186 t/s · TTFT 17s"),
    });
    const headerHandle = pluginButtonStore.addHeaderButton(plugin, {
      id: "usage-header",
      workspaceId: "ws-1",
      button: popoverButton("Header Action", "Header Action"),
    });
    cleanups.push(
      () => pillHandle.remove(),
      () => headerHandle.remove(),
    );

    const composerRoot = render(
      <PluginComposerPills
        serverId="host-1"
        workspaceId="ws-1"
        agentId="agent-1"
        compact={false}
      />,
    );
    const headerRoot = render(<PluginHeaderButtons serverId="host-1" workspaceId="ws-1" />);

    const composerTrigger = composerRoot.querySelector('button[aria-label="Live Usage"]');
    const headerTrigger = headerRoot.querySelector('button[aria-label="Header Action"]');

    expect(composerTrigger?.getAttribute("data-max-width")).toBe(
      String(PLUGIN_COMPOSER_PILL_MAX_WIDTH),
    );
    expect(composerTrigger?.getAttribute("data-flex-shrink")).toBe("1");
    expect(composerTrigger?.getAttribute("data-min-width")).toBe("0");

    expect(headerTrigger?.getAttribute("data-max-width")).toBe(
      String(PLUGIN_HEADER_BUTTON_MAX_WIDTH),
    );
    expect(PLUGIN_COMPOSER_PILL_MAX_WIDTH).toBeGreaterThan(PLUGIN_HEADER_BUTTON_MAX_WIDTH);
  });
});
