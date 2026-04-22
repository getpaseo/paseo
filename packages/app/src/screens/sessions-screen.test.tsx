/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHistoryResult } from "@/hooks/use-agent-history";
import { SessionsScreen } from "@/screens/sessions-screen";

const { historyResult, navigate } = vi.hoisted(() => ({
  historyResult: {
    current: null as AgentHistoryResult | null,
  },
  navigate: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("div", props, children),
  Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("span", props, children),
}));

vi.mock("react-native-unistyles", () => {
  const theme = {
    spacing: { 4: 16, 6: 24 },
    fontSize: { lg: 18 },
    colors: {
      surface0: "#111",
      foregroundMuted: "#999",
    },
  };

  return {
    StyleSheet: {
      create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
    },
    useUnistyles: () => ({ theme }),
  };
});

vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
}));

vi.mock("expo-router", () => ({
  router: {
    navigate,
  },
}));

vi.mock("lucide-react-native", () => ({
  ChevronLeft: () => React.createElement("span", { "data-icon": "ChevronLeft" }),
}));

vi.mock("@/components/headers/menu-header", () => ({
  MenuHeader: ({ title }: { title: string }) =>
    React.createElement("header", { "data-testid": "menu-header" }, title),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onPress }: React.PropsWithChildren<{ onPress?: () => void }>) =>
    React.createElement("button", { onClick: onPress }, children),
}));

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: ({ color, size }: { color: string; size?: string }) =>
    React.createElement("div", {
      "data-color": color,
      "data-size": size,
      "data-testid": "sessions-loading-spinner",
    }),
}));

vi.mock("@/components/agent-list", () => ({
  AgentList: ({ agents }: { agents: unknown[] }) =>
    React.createElement("div", { "data-agent-count": agents.length, "data-testid": "agent-list" }),
}));

vi.mock("@/hooks/use-agent-history", () => ({
  useAgentHistory: () => {
    if (!historyResult.current) {
      throw new Error("Expected history result");
    }
    return historyResult.current;
  },
}));

vi.mock("@/utils/host-routes", () => ({
  buildHostOpenProjectRoute: (serverId: string) => `/h/${serverId}/open-project`,
}));

function makeHistoryResult(overrides: Partial<AgentHistoryResult> = {}): AgentHistoryResult {
  return {
    agents: [],
    isLoading: false,
    isInitialLoad: false,
    isRevalidating: false,
    hasMore: false,
    isLoadingMore: false,
    refreshAll: vi.fn(),
    loadMore: vi.fn(),
    ...overrides,
  };
}

describe("SessionsScreen", () => {
  let container: HTMLElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    navigate.mockReset();
    historyResult.current = makeHistoryResult();
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
    historyResult.current = null;
    vi.unstubAllGlobals();
  });

  it("shows the shared loader during the initial React Query history load", () => {
    historyResult.current = makeHistoryResult({ isInitialLoad: true, isLoading: true });

    act(() => {
      root?.render(<SessionsScreen serverId="server-1" />);
    });

    expect(container?.querySelector('[data-testid="sessions-loading-spinner"]')).not.toBeNull();
    expect(container?.textContent).not.toContain("No sessions yet");
    expect(container?.textContent).not.toContain("Back");
  });

  it("shows the empty state after history finishes loading with no sessions", () => {
    historyResult.current = makeHistoryResult();

    act(() => {
      root?.render(<SessionsScreen serverId="server-1" />);
    });

    expect(container?.querySelector('[data-testid="sessions-loading-spinner"]')).toBeNull();
    expect(container?.textContent).toContain("No sessions yet");
    expect(container?.textContent).toContain("Back");
  });
});
