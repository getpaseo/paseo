/**
 * @vitest-environment jsdom
 */
import { i18n as testI18n } from "@/i18n/i18next";
import React, { type ReactElement } from "react";
import { act, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkspaceLaunchPayload } from "@getpaseo/protocol/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { WorkspaceLaunchesButton } from "@/screens/workspace/workspace-launches-button";

void testI18n;

const {
  theme,
  startWorkspaceLaunchMock,
  stopWorkspaceLaunchMock,
  launchTerminalStartedMock,
  viewTerminalMock,
} = vi.hoisted(() => {
  const hoistedTheme = {
    spacing: { 1: 4, 1.5: 6, 2: 8, 3: 12, 8: 32 },
    borderWidth: { 1: 1 },
    borderRadius: { sm: 4, md: 6, lg: 8 },
    fontSize: { sm: 13, base: 15 },
    fontWeight: { normal: "400" },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface2: "#222",
      borderAccent: "#444",
      palette: { blue: { 500: "#0a84ff" } },
    },
  };
  return {
    theme: hoistedTheme,
    startWorkspaceLaunchMock: vi.fn(async () => ({
      requestId: "request-1",
      workspaceId: "workspace-1",
      launchName: "dev",
      launch: {
        launchName: "dev",
        lifecycle: "running",
        active: true,
        portBase: null,
        portEnd: null,
        portCount: null,
        composeProjectName: null,
        endpoints: [],
        exitCode: null,
        terminalId: "terminal-dev",
      },
      error: null,
    })),
    stopWorkspaceLaunchMock: vi.fn(async () => ({
      requestId: "request-2",
      workspaceId: "workspace-1",
      launchName: "dev",
      launch: null,
      error: null,
    })),
    launchTerminalStartedMock: vi.fn(),
    viewTerminalMock: vi.fn(),
  };
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

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: {
        "test-server": {
          client: {
            startWorkspaceLaunch: startWorkspaceLaunchMock,
            stopWorkspaceLaunch: stopWorkspaceLaunchMock,
          },
        },
      },
    }),
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ show: vi.fn() }),
}));

vi.mock("@/utils/open-service-url", () => ({
  openServiceUrl: vi.fn(),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
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
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children as ReactElement,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children as ReactElement,
  TooltipContent: ({ children }: { children: React.ReactNode }) => children as ReactElement,
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", {
      "data-icon": name,
      "data-color": props.color,
      "data-size": props.size,
    });
  return {
    ChevronDown: createIcon("ChevronDown"),
    Globe: createIcon("Globe"),
    Play: createIcon("Play"),
    Square: createIcon("Square"),
    SquareTerminal: createIcon("SquareTerminal"),
  };
});

vi.mock("react-native", async () => vi.importActual<Record<string, unknown>>("react-native"));

function launch(
  input: Partial<WorkspaceLaunchPayload> & Pick<WorkspaceLaunchPayload, "launchName">,
): WorkspaceLaunchPayload {
  return {
    launchName: input.launchName,
    lifecycle: input.lifecycle ?? "stopped",
    active: input.active ?? false,
    portBase: input.portBase ?? null,
    portEnd: input.portEnd ?? null,
    portCount: input.portCount ?? null,
    composeProjectName: input.composeProjectName ?? null,
    endpoints: input.endpoints ?? [],
    exitCode: input.exitCode ?? null,
    terminalId: input.terminalId ?? null,
  };
}

function renderLaunches(launches: WorkspaceLaunchPayload[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceLaunchesButton
          serverId="test-server"
          workspaceId="workspace-1"
          launches={launches}
          liveTerminalIds={["terminal-dev"]}
          onLaunchTerminalStarted={launchTerminalStartedMock}
          onViewTerminal={viewTerminalMock}
        />
      </QueryClientProvider>,
    );
  });
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

describe("WorkspaceLaunchesButton", () => {
  let unmount: (() => void) | null = null;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    document.body.innerHTML = "";
    startWorkspaceLaunchMock.mockClear();
    stopWorkspaceLaunchMock.mockClear();
    launchTerminalStartedMock.mockClear();
    viewTerminalMock.mockClear();
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
    vi.unstubAllGlobals();
  });

  it("starts a stopped launch through the launch RPC", async () => {
    unmount = renderLaunches([launch({ launchName: "dev", portBase: 4100, portEnd: 4199 })]);

    const startButton = document.querySelector('[data-testid="workspace-launches-start-dev"]');
    expect(startButton).not.toBeNull();
    fireEvent.click(startButton as HTMLElement);
    await act(async () => {});

    expect(startWorkspaceLaunchMock).toHaveBeenCalledWith("workspace-1", "dev");
    expect(launchTerminalStartedMock).toHaveBeenCalledWith("terminal-dev");
    expect(document.body.textContent).toContain("ports 4100–4199");
  });

  it("stops a running launch and exposes its live terminal", async () => {
    unmount = renderLaunches([
      launch({
        launchName: "dev",
        lifecycle: "running",
        active: true,
        terminalId: "terminal-dev",
      }),
    ]);

    const stopButton = document.querySelector('[data-testid="workspace-launches-stop-dev"]');
    const terminalButton = document.querySelector('[data-testid="workspace-launches-view-dev"]');
    expect(stopButton).not.toBeNull();
    expect(terminalButton).not.toBeNull();
    fireEvent.click(stopButton as HTMLElement);
    fireEvent.click(terminalButton as HTMLElement);
    await act(async () => {});

    expect(stopWorkspaceLaunchMock).toHaveBeenCalledWith("workspace-1", "dev");
    expect(viewTerminalMock).toHaveBeenCalledWith("terminal-dev");
    expect(document.body.textContent).toContain("View terminal");
  });

  it("shows every detected launch endpoint, with its port", () => {
    unmount = renderLaunches([
      launch({
        launchName: "dev",
        lifecycle: "running",
        active: true,
        endpoints: [
          {
            id: "dev:p0",
            port: 4100,
            hostname: "launch-dev-p0--project.localhost",
            localProxyUrl: "http://launch-dev-p0--project.localhost:6767",
            publicProxyUrl: null,
            proxyUrl: "http://launch-dev-p0--project.localhost:6767",
            health: null,
          },
          {
            id: "dev:p2",
            port: 4102,
            hostname: "launch-dev-p2--project.localhost",
            localProxyUrl: "http://launch-dev-p2--project.localhost:6767",
            publicProxyUrl: null,
            proxyUrl: "http://launch-dev-p2--project.localhost:6767",
            health: null,
          },
        ],
      }),
    ]);

    expect(document.body.textContent).toContain("4100");
    expect(document.body.textContent).toContain("4102");
    expect(
      document.querySelector('[data-testid="workspace-launches-open-dev-dev:p0"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="workspace-launches-open-dev-dev:p2"]'),
    ).not.toBeNull();
  });
});
