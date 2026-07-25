/**
 * @vitest-environment jsdom
 */
import { i18n as testI18n } from "@/i18n/i18next";
import React, { type ReactElement } from "react";
import { act, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { WorkspaceScriptsButton } from "@/screens/workspace/workspace-scripts-button";

void testI18n;

const {
  theme,
  startWorkspaceScriptMock,
  killTerminalMock,
  setStringAsyncMock,
  copiedToastMock,
  routePreferenceByServerIdMock,
  routePreferenceListenersMock,
  setPreferredRouteMock,
} = vi.hoisted(() => {
  const hoistedTheme = {
    spacing: { 1: 4, 1.5: 6, 2: 8, 3: 12 },
    borderWidth: { 1: 1 },
    borderRadius: { md: 6, lg: 8 },
    fontSize: { xs: 11, sm: 13 },
    fontWeight: { normal: "400", medium: "500" },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface2: "#222",
      borderAccent: "#444",
      palette: {
        blue: { 500: "#0a84ff" },
        green: { 500: "#30d158" },
        red: { 300: "#ff9f99", 500: "#ff453a" },
      },
    },
  };

  const routePreferenceByServerId: Record<string, "public" | "paseo" | "direct"> = {};
  const routePreferenceListeners = new Set<() => void>();
  const setPreferredRoute = vi.fn((serverId: string, kind: "public" | "paseo" | "direct") => {
    routePreferenceByServerId[serverId] = kind;
    for (const listener of routePreferenceListeners) listener();
  });

  return {
    theme: hoistedTheme,
    startWorkspaceScriptMock: vi.fn(async () => ({ terminalId: "terminal-script-1" })),
    killTerminalMock: vi.fn(async () => ({
      terminalId: "terminal-script-1",
      success: true,
      requestId: "request-1",
    })),
    setStringAsyncMock: vi.fn(async () => true),
    copiedToastMock: vi.fn(),
    routePreferenceByServerIdMock: routePreferenceByServerId,
    routePreferenceListenersMock: routePreferenceListeners,
    setPreferredRouteMock: setPreferredRoute,
  };
});

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) =>
    ({
      uniProps,
      ...rest
    }: {
      uniProps?: (theme: unknown) => Record<string, unknown>;
    } & Record<string, unknown>) => {
      const themed = uniProps ? uniProps(theme) : {};
      return React.createElement(Component, { ...rest, ...themed });
    },
}));

vi.mock("@/constants/platform", () => ({
  isNative: false,
  isWeb: true,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeSnapshot: () => ({ activeConnection: null }),
}));

vi.mock("@/workspace-service-routes/store", async () => {
  const ReactModule = await vi.importActual<typeof import("react")>("react");
  const state = {
    byServerId: routePreferenceByServerIdMock,
    setPreferredRoute: setPreferredRouteMock,
  };
  return {
    useWorkspaceServiceRoutePreferencesStore: <T,>(selector: (value: typeof state) => T) =>
      ReactModule.useSyncExternalStore(
        (listener) => {
          routePreferenceListenersMock.add(listener);
          return () => routePreferenceListenersMock.delete(listener);
        },
        () => selector(state),
        () => selector(state),
      ),
  };
});

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: {
        "test-server": {
          client: {
            startWorkspaceScript: startWorkspaceScriptMock,
            killTerminal: killTerminalMock,
          },
        },
      },
    }),
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ show: vi.fn(), error: vi.fn(), copied: copiedToastMock }),
}));

vi.mock("expo-clipboard", () => ({
  setStringAsync: setStringAsyncMock,
}));

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: vi.fn(),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  DropdownMenuSeparator: () => <div role="separator" />,
  DropdownMenuItem: ({
    children,
    description,
    onSelect,
    testID,
  }: {
    children: React.ReactNode;
    description?: string;
    onSelect?: () => void;
    testID?: string;
  }) => (
    <button type="button" data-testid={testID} onClick={onSelect}>
      {children}
      {description}
    </button>
  ),
  DropdownMenuTrigger: ({
    children,
    testID,
  }: {
    children:
      | React.ReactNode
      | ((state: { hovered: boolean; pressed: boolean; open: boolean }) => React.ReactNode);
    testID?: string;
  }) => (
    <button type="button" data-testid={testID}>
      {typeof children === "function"
        ? children({ hovered: false, pressed: false, open: true })
        : children}
    </button>
  ),
  useDropdownMenuClose: () => () => {},
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children as ReactElement,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children as ReactElement,
  TooltipContent: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", {
      "data-icon": name,
      "data-color": props.color,
      "data-size": props.size,
      "data-testid": props.testID,
    });
  return {
    ChevronDown: createIcon("ChevronDown"),
    Copy: createIcon("Copy"),
    Eye: createIcon("Eye"),
    ExternalLink: createIcon("ExternalLink"),
    Globe: createIcon("Globe"),
    Play: createIcon("Play"),
    RotateCw: createIcon("RotateCw"),
    Square: createIcon("Square"),
    SquareTerminal: createIcon("SquareTerminal"),
  };
});

vi.mock("react-native", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("react-native");
  return actual;
});

function script(
  input: Partial<WorkspaceScriptPayload> & Pick<WorkspaceScriptPayload, "scriptName">,
): WorkspaceScriptPayload {
  return {
    scriptName: input.scriptName,
    type: input.type ?? "script",
    hostname: input.hostname ?? input.scriptName,
    port: input.port ?? null,
    localProxyUrl: input.localProxyUrl,
    publicProxyUrl: input.publicProxyUrl,
    proxyUrl: input.proxyUrl ?? null,
    lifecycle: input.lifecycle ?? "stopped",
    health: input.health ?? null,
    exitCode: input.exitCode ?? null,
    terminalId: input.terminalId ?? null,
  };
}

const LIVE_TERMINAL_IDS: string[] = ["terminal-script-1"];

interface RenderScriptsOptions {
  hideLabels?: boolean;
  presentation?: "split" | "ghost";
}

function renderScripts(
  scripts: WorkspaceScriptPayload[],
  options: RenderScriptsOptions = {},
): {
  rerender: (nextScripts: WorkspaceScriptPayload[]) => Promise<void>;
  unmount: () => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  function element(nextScripts: WorkspaceScriptPayload[]): ReactElement {
    return (
      <QueryClientProvider client={queryClient}>
        <WorkspaceScriptsButton
          serverId="test-server"
          workspaceId="workspace-1"
          scripts={nextScripts}
          liveTerminalIds={LIVE_TERMINAL_IDS}
          hideLabels={options.hideLabels}
          presentation={options.presentation}
        />
      </QueryClientProvider>
    );
  }

  act(() => {
    root.render(element(scripts));
  });

  return {
    rerender: async (nextScripts) => {
      await act(async () => {
        root.render(element(nextScripts));
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function requireRow(scriptName: string): HTMLElement {
  const row = document.querySelector(`[data-testid="workspace-scripts-item-${scriptName}"]`);
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Missing script row for ${scriptName}`);
  }
  return row;
}

function requirePrimaryIcon(row: HTMLElement): HTMLElement {
  const icon = row.querySelector("[data-icon]");
  if (!(icon instanceof HTMLElement)) {
    throw new Error("Missing row icon");
  }
  return icon;
}

describe("WorkspaceScriptsButton", () => {
  let current: ReturnType<typeof renderScripts> | null = null;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    document.body.innerHTML = "";
    startWorkspaceScriptMock.mockClear();
    killTerminalMock.mockClear();
    setStringAsyncMock.mockClear();
    copiedToastMock.mockClear();
    setPreferredRouteMock.mockClear();
    for (const serverId of Object.keys(routePreferenceByServerIdMock)) {
      delete routePreferenceByServerIdMock[serverId];
    }
  });

  afterEach(() => {
    current?.unmount();
    current = null;
    vi.unstubAllGlobals();
  });

  it("keeps completed script row icons visible and muted while the menu content stays mounted", async () => {
    current = renderScripts([
      script({
        scriptName: "typecheck",
        lifecycle: "running",
        terminalId: "terminal-script-1",
      }),
    ]);

    let row = requireRow("typecheck");
    let icon = requirePrimaryIcon(row);
    expect(icon.dataset.icon).toBe("SquareTerminal");
    expect(icon.dataset.color).toBe(theme.colors.palette.blue[500]);

    await current.rerender([
      script({
        scriptName: "typecheck",
        lifecycle: "stopped",
        exitCode: 0,
        terminalId: "terminal-script-1",
      }),
    ]);

    row = requireRow("typecheck");
    icon = requirePrimaryIcon(row);
    expect(icon.dataset.icon).toBe("SquareTerminal");
    expect(icon.dataset.color).toBe(theme.colors.foregroundMuted);
    expect(row.textContent).toContain("typecheck");
    expect(row.textContent).toContain("exit 0");
    expect(row.querySelector('[data-testid="workspace-scripts-start-typecheck"]')).not.toBeNull();

    await current.rerender([
      script({
        scriptName: "typecheck",
        lifecycle: "stopped",
        exitCode: 7,
        terminalId: "terminal-script-1",
      }),
    ]);

    row = requireRow("typecheck");
    icon = requirePrimaryIcon(row);
    expect(icon.dataset.icon).toBe("SquareTerminal");
    expect(icon.dataset.color).toBe(theme.colors.foregroundMuted);
    expect(row.textContent).toContain("exit 7");
    expect(row.querySelector('[data-testid="workspace-scripts-start-typecheck"]')).not.toBeNull();
  });

  it("uses service icon color for service health and running unknown status only", () => {
    current = renderScripts([
      script({
        scriptName: "web",
        type: "service",
        hostname: "web.paseo.localhost",
        lifecycle: "running",
        health: "healthy",
        port: 3000,
      }),
      script({
        scriptName: "api",
        type: "service",
        hostname: "api.paseo.localhost",
        lifecycle: "running",
        health: "unhealthy",
        port: 4000,
      }),
      script({
        scriptName: "worker",
        type: "service",
        hostname: "worker.paseo.localhost",
        lifecycle: "running",
        health: null,
        port: 5000,
      }),
      script({
        scriptName: "old-service",
        type: "service",
        hostname: "old-service.paseo.localhost",
        lifecycle: "stopped",
        exitCode: 1,
      }),
    ]);

    expect(requirePrimaryIcon(requireRow("web")).dataset.color).toBe(
      theme.colors.palette.green[500],
    );
    expect(requirePrimaryIcon(requireRow("api")).dataset.color).toBe(theme.colors.palette.red[500]);
    expect(requirePrimaryIcon(requireRow("worker")).dataset.color).toBe(
      theme.colors.palette.blue[500],
    );
    expect(requirePrimaryIcon(requireRow("old-service")).dataset.color).toBe(
      theme.colors.foregroundMuted,
    );
  });

  it("removes the trigger caret in ghost presentation", () => {
    current = renderScripts([script({ scriptName: "dev" })], {
      hideLabels: true,
      presentation: "ghost",
    });

    const trigger = document.querySelector('[data-testid="workspace-scripts-button"]');
    expect(trigger?.querySelector('[data-icon="Play"]')?.getAttribute("data-size")).toBe("16");
    expect(trigger?.querySelector('[data-icon="ChevronDown"]')).toBeNull();
  });

  it("keeps the trigger caret in split presentation", () => {
    current = renderScripts([script({ scriptName: "dev" })]);

    const trigger = document.querySelector('[data-testid="workspace-scripts-button"]');
    expect(trigger?.querySelector('[data-icon="ChevronDown"]')).not.toBeNull();
  });

  it("persists the selected route for the host", () => {
    const scripts = [
      script({
        scriptName: "dev",
        type: "service",
        hostname: "dev--proj--repo.localhost",
        lifecycle: "running",
        port: 57483,
        proxyUrl: "http://dev--proj--repo.localhost:6767",
        terminalId: "terminal-script-1",
      }),
    ];
    current = renderScripts(scripts);

    const row = requireRow("dev");
    expect(row.textContent).toContain("dev--proj--repo.localhost:6767");

    const routeButton = row.querySelector('[data-testid="workspace-scripts-route-dev"]');
    expect(routeButton).not.toBeNull();
    fireEvent.click(
      row.querySelector('[data-testid="workspace-scripts-route-dev-direct"]') as HTMLElement,
    );
    expect(setPreferredRouteMock).toHaveBeenCalledWith("test-server", "direct");
    expect(row.textContent).toContain("localhost:57483");

    const copyButton = row.querySelector('[data-testid="workspace-scripts-copy-dev"]');
    expect(copyButton).not.toBeNull();
    fireEvent.click(copyButton as HTMLElement);
    expect(setStringAsyncMock).toHaveBeenCalledWith("http://localhost:57483");
    expect(copiedToastMock).toHaveBeenCalledWith("localhost:57483");

    current.unmount();
    current = renderScripts(scripts);
    expect(requireRow("dev").textContent).toContain("localhost:57483");
  });

  it("defaults to a configured reverse proxy URL", () => {
    current = renderScripts([
      script({
        scriptName: "dev",
        type: "service",
        lifecycle: "running",
        port: 57483,
        localProxyUrl: "http://dev--proj--repo.localhost:6767",
        publicProxyUrl: "https://dev--proj--repo.services.example.com",
        proxyUrl: "https://dev--proj--repo.services.example.com",
        terminalId: "terminal-script-1",
      }),
    ]);

    expect(requireRow("dev").textContent).toContain("dev--proj--repo.services.example.com");
  });

  it("stops a running script through its terminal", async () => {
    current = renderScripts([
      script({
        scriptName: "dev",
        lifecycle: "running",
        terminalId: "terminal-script-1",
      }),
    ]);

    const stopButton = requireRow("dev").querySelector(
      '[data-testid="workspace-scripts-stop-dev"]',
    );
    expect(stopButton).not.toBeNull();
    fireEvent.click(stopButton as HTMLElement);
    await act(async () => {});

    expect(killTerminalMock).toHaveBeenCalledWith("terminal-script-1");
  });

  it("uses icon-only actions with view and fixed-position lifecycle controls", async () => {
    current = renderScripts([
      script({
        scriptName: "dev",
        lifecycle: "stopped",
        terminalId: "terminal-script-1",
      }),
    ]);

    let row = requireRow("dev");
    let buttons = Array.from(row.querySelectorAll("button"));
    expect(buttons).toHaveLength(1);
    expect(buttons.at(-1)?.dataset.testid).toBe("workspace-scripts-start-dev");
    expect(buttons.at(-1)?.querySelector('[data-icon="Play"]')).not.toBeNull();
    expect(buttons.at(-1)?.textContent).toBe("");

    await current.rerender([
      script({
        scriptName: "dev",
        lifecycle: "running",
        terminalId: "terminal-script-1",
      }),
    ]);

    row = requireRow("dev");
    buttons = Array.from(row.querySelectorAll("button"));
    expect(buttons.map((button) => button.dataset.testid)).toEqual([
      "workspace-scripts-view-dev",
      "workspace-scripts-restart-dev",
      "workspace-scripts-stop-dev",
    ]);
    expect(buttons[0]?.querySelector('[data-icon="SquareTerminal"]')).not.toBeNull();
    expect(buttons.at(-1)?.querySelector('[data-icon="Square"]')).not.toBeNull();
    expect(buttons.every((button) => button.textContent === "")).toBe(true);
  });

  it("adds localized tooltips to every icon action", () => {
    current = renderScripts([
      script({
        scriptName: "dev",
        type: "service",
        lifecycle: "running",
        port: 3000,
        proxyUrl: "http://dev--project.localhost:6767",
        terminalId: "terminal-script-1",
      }),
    ]);

    expect(
      document.querySelector('[data-testid="workspace-scripts-view-dev-tooltip"]')?.textContent,
    ).toBe("View terminal");
    expect(
      document.querySelector('[data-testid="workspace-scripts-restart-dev-tooltip"]')?.textContent,
    ).toBe("Restart");
    expect(
      document.querySelector('[data-testid="workspace-scripts-stop-dev-tooltip"]')?.textContent,
    ).toBe("Stop");
    expect(
      document.querySelector('[data-testid="workspace-scripts-copy-dev-tooltip"]')?.textContent,
    ).toBe("Copy URL");
    expect(
      document.querySelector('[data-testid="workspace-scripts-route-dev-tooltip"]')?.textContent,
    ).toBe("Choose URL");
  });

  it("restarts a script once its stopped lifecycle arrives", async () => {
    current = renderScripts([
      script({
        scriptName: "dev",
        lifecycle: "running",
        terminalId: "terminal-script-1",
      }),
    ]);

    const restartButton = requireRow("dev").querySelector(
      '[data-testid="workspace-scripts-restart-dev"]',
    );
    expect(restartButton).not.toBeNull();
    fireEvent.click(restartButton as HTMLElement);
    await act(async () => {});

    expect(killTerminalMock).toHaveBeenCalledWith("terminal-script-1");
    expect(startWorkspaceScriptMock).not.toHaveBeenCalled();

    await current.rerender([
      script({
        scriptName: "dev",
        lifecycle: "stopped",
        exitCode: 0,
        terminalId: "terminal-script-1",
      }),
    ]);
    await act(async () => {});

    expect(startWorkspaceScriptMock).toHaveBeenCalledWith("workspace-1", "dev");
  });
});
