/**
 * @vitest-environment jsdom
 */
import React, { type ReactElement } from "react";
import { act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkspaceScriptPayload } from "@server/shared/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { WorkspaceScriptsButton } from "@/screens/workspace/workspace-scripts-button";

const { theme, startWorkspaceScriptMock } = vi.hoisted(() => {
  const theme = {
    spacing: { 1: 4, 1.5: 6, 2: 8, 3: 12 },
    borderWidth: { 1: 1 },
    borderRadius: { md: 6 },
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

  return {
    theme,
    startWorkspaceScriptMock: vi.fn(async () => ({ terminalId: "terminal-script-1" })),
  };
});

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("@/constants/platform", () => ({
  isNative: false,
  isWeb: true,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeSnapshot: () => ({ activeConnection: null }),
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: {
        "test-server": {
          client: {
            startWorkspaceScript: startWorkspaceScriptMock,
          },
        },
      },
    }),
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ show: vi.fn(), error: vi.fn() }),
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
    ExternalLink: createIcon("ExternalLink"),
    Globe: createIcon("Globe"),
    Play: createIcon("Play"),
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
    proxyUrl: input.proxyUrl ?? null,
    lifecycle: input.lifecycle ?? "stopped",
    health: input.health ?? null,
    exitCode: input.exitCode ?? null,
    terminalId: input.terminalId ?? null,
  };
}

function renderScripts(scripts: WorkspaceScriptPayload[]): {
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
          liveTerminalIds={["terminal-script-1"]}
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
    expect(row.textContent).toContain("Run");

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
    expect(row.textContent).toContain("Run");
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
});
