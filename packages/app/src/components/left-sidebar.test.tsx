/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { panelState, useSidebarWorkspacesListMock, theme } = vi.hoisted(() => {
  const panelState = {
    isOpen: false,
    showMobileAgent: vi.fn(),
  };

  return {
    panelState,
    useSidebarWorkspacesListMock: vi.fn(),
    theme: {
      spacing: { 0: 0, 0.5: 2, 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16, 5: 20 },
      iconSize: { sm: 14, md: 18, lg: 22 },
      borderWidth: { 1: 1 },
      borderRadius: { sm: 4, md: 6, lg: 8, full: 999 },
      fontSize: { xs: 11, sm: 13, base: 15 },
      fontWeight: { normal: "400", medium: "500", semibold: "600" },
      colors: {
        surfaceSidebar: "#111",
        surface1: "#111",
        surface2: "#222",
        surface3: "#333",
        surface4: "#444",
        foreground: "#fff",
        foregroundMuted: "#aaa",
        border: "#555",
        borderAccent: "#666",
        accent: "#0a84ff",
        accentForeground: "#fff",
        palette: {
          green: { 400: "#30d158" },
          amber: { 500: "#ffd60a" },
          red: { 500: "#ff453a" },
        },
      },
    },
  };
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    absoluteFillObject: {},
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("react-native-reanimated", () => ({
  default: {
    View: "div",
  },
  Extrapolation: { CLAMP: "clamp" },
  interpolate: () => 0,
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useSharedValue: (value: unknown) => ({ value }),
}));

vi.mock("react-native-gesture-handler", () => {
  const chain = {
    enabled: () => chain,
    hitSlop: () => chain,
    manualActivation: () => chain,
    onTouchesDown: () => chain,
    onTouchesMove: () => chain,
    onStart: () => chain,
    onUpdate: () => chain,
    onEnd: () => chain,
    onFinalize: () => chain,
    withRef: () => chain,
  };
  return {
    Gesture: { Pan: () => chain },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  };
});

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": name });
  return {
    MessagesSquare: createIcon("MessagesSquare"),
    Plus: createIcon("Plus"),
    Settings: createIcon("Settings"),
  };
});

vi.mock("expo-router", () => ({
  router: { push: vi.fn() },
  usePathname: () => "/hosts/srv",
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => true,
}));

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
}));

vi.mock("@/stores/panel-store", () => ({
  MIN_SIDEBAR_WIDTH: 260,
  MAX_SIDEBAR_WIDTH: 420,
  selectIsAgentListOpen: (state: typeof panelState) => state.isOpen,
  usePanelStore: (selector: (state: typeof panelState) => unknown) => selector(panelState),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [{ serverId: "srv", label: "Local" }],
  useHostRuntimeSnapshot: () => ({ connectionStatus: "online" }),
}));

vi.mock("@/hooks/use-sidebar-workspaces-list", () => ({
  useSidebarWorkspacesList: useSidebarWorkspacesListMock,
}));

vi.mock("@/hooks/use-sidebar-shortcut-model", () => ({
  useSidebarShortcutModel: () => ({
    collapsedProjectKeys: new Set<string>(),
    shortcutIndexByWorkspaceKey: new Map<string, number>(),
    toggleProjectCollapsed: vi.fn(),
  }),
}));

vi.mock("@/contexts/sidebar-animation-context", () => ({
  useSidebarAnimation: () => ({
    translateX: { value: 0 },
    backdropOpacity: { value: 0 },
    windowWidth: 390,
    animateToOpen: vi.fn(),
    animateToClose: vi.fn(),
    isGesturing: { value: false },
    gestureAnimatingRef: { current: false },
    closeGestureRef: { current: undefined },
  }),
}));

vi.mock("@/hooks/use-shortcut-keys", () => ({
  useShortcutKeys: () => null,
}));

vi.mock("@/utils/desktop-window", () => ({
  useWindowControlsPadding: () => ({ top: 0 }),
}));

vi.mock("@/utils/host-routes", () => ({
  buildHostSessionsRoute: (serverId: string) => `/hosts/${serverId}/sessions`,
  buildSettingsRoute: () => "/settings",
  mapPathnameToServer: (_pathname: string, serverId: string) => `/hosts/${serverId}`,
  parseServerIdFromPathname: () => "srv",
}));

vi.mock("@/hooks/use-open-project-picker", () => ({
  useOpenProjectPicker: () => vi.fn(),
}));

vi.mock("@/components/sidebar/sidebar-header-row", () => ({
  SidebarHeaderRow: ({ label }: { label: string }) => React.createElement("div", null, label),
}));

vi.mock("./sidebar-workspace-list", () => ({
  SidebarWorkspaceList: ({ projects }: { projects: Array<{ projectName: string }> }) =>
    React.createElement(
      "div",
      { "data-testid": "sidebar-workspace-list" },
      projects.map((project) => project.projectName).join(","),
    ),
}));

vi.mock("./sidebar-agent-list-skeleton", () => ({
  SidebarAgentListSkeleton: () => React.createElement("div", null, "Loading"),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
}));

vi.mock("@/components/ui/shortcut", () => ({
  Shortcut: () => React.createElement("span", null),
}));

vi.mock("@/components/ui/combobox", () => ({
  Combobox: () => null,
  ComboboxItem: ({ label }: { label: string }) => React.createElement("div", null, label),
}));

vi.stubGlobal("React", React);

import { LeftSidebar } from "./left-sidebar";

describe("LeftSidebar", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    panelState.isOpen = false;
    panelState.showMobileAgent.mockReset();
    useSidebarWorkspacesListMock.mockReset();
    useSidebarWorkspacesListMock.mockReturnValue({
      projects: [{ projectKey: "project-1", projectName: "Project 1", workspaces: [] }],
      isInitialLoad: false,
      isRevalidating: false,
      refreshAll: vi.fn(),
    });
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
  });

  it("keeps the mobile workspace list subscribed while the sidebar is hidden", async () => {
    await act(async () => {
      root?.render(<LeftSidebar />);
    });

    expect(useSidebarWorkspacesListMock).toHaveBeenLastCalledWith({
      serverId: "srv",
      enabled: true,
    });
  });
});
