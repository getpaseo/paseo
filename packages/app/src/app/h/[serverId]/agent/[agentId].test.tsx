import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HostAgentReadyRoute from "./[agentId]";

const { theme, replaceMock, fetchAgentMock, mockRouteParams, mockSessionState } = vi.hoisted(() => {
  const theme = {
    spacing: { 3: 12, 6: 24 },
    fontSize: { sm: 13 },
    colors: {
      foregroundMuted: "#999",
      surface0: "#000",
    },
  };

  return {
    theme,
    replaceMock: vi.fn(),
    fetchAgentMock: vi.fn(async () => ({
      agent: {
        cwd: "/repo",
      },
    })),
    mockRouteParams: {
      serverId: "server-1",
      agentId: "agent-1",
    } as {
      serverId?: string;
      agentId?: string;
    },
    mockSessionState: {
      sessions: {
        "server-1": {
          agents: new Map<string, { cwd: string | null }>([["agent-1", { cwd: null }]]),
          hasHydratedWorkspaces: false,
          workspaces: new Map(),
        },
      },
    } as {
      sessions: Record<
        string,
        {
          agents: Map<string, { cwd: string | null }>;
          hasHydratedWorkspaces: boolean;
          workspaces: Map<string, unknown>;
        }
      >;
    },
  };
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => mockRouteParams,
  useRouter: () => ({
    replace: replaceMock,
  }),
}));

vi.mock("@/components/host-route-bootstrap-boundary", () => ({
  HostRouteBootstrapBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: Object.assign(
    (selector: (state: typeof mockSessionState) => unknown) => selector(mockSessionState),
    {
      getState: () => mockSessionState,
    },
  ),
}));

vi.mock("@/stores/session-store-hooks", () => ({
  useResolveWorkspaceIdByCwd: () => null,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({
    fetchAgent: fetchAgentMock,
  }),
  useHostRuntimeIsConnected: () => true,
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  replaceMock.mockReset();
  fetchAgentMock.mockClear();
  mockRouteParams.serverId = "server-1";
  mockRouteParams.agentId = "agent-1";
  mockSessionState.sessions["server-1"] = {
    agents: new Map([["agent-1", { cwd: null }]]),
    hasHydratedWorkspaces: false,
    workspaces: new Map(),
  };
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderRoute() {
  act(() => {
    root?.render(<HostAgentReadyRoute />);
  });
}

describe("HostAgentReadyRoute", () => {
  it("renders a loading message while the workspace lookup is still resolving", async () => {
    renderRoute();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container?.textContent).toContain("Opening session");
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("redirects back to the host root when bootstrap takes too long", async () => {
    vi.useFakeTimers();

    renderRoute();

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(container?.textContent).toContain("Redirecting");
    expect(replaceMock).toHaveBeenCalledWith("/h/server-1");
  });
});
