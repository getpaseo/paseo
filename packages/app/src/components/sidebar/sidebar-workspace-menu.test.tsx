/**
 * @vitest-environment jsdom
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
});

import React from "react";
import { SidebarWorkspaceMenu } from "./sidebar-workspace-menu";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12 },
    borderWidth: { 1: 1 },
    borderRadius: { md: 6 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400" },
    iconSize: { sm: 14 },
    shadow: { md: {} },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      surface3: "#333",
      border: "#444",
      borderAccent: "#555",
      palette: {
        green: { 500: "#22c55e" },
        amber: { 500: "#f59e0b" },
        red: { 500: "#ef4444" },
        blue: { 500: "#3b82f6" },
      },
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  useUnistyles: () => ({ theme }),
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

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => {
    const Icon = () => React.createElement("span", { "data-icon": name });
    Icon.displayName = name;
    return Icon;
  };
  return {
    Archive: icon("Archive"),
    CircleCheck: icon("CircleCheck"),
    Copy: icon("Copy"),
    FolderOpen: icon("FolderOpen"),
    MoreVertical: icon("MoreVertical"),
    Pencil: icon("Pencil"),
    Pin: icon("Pin"),
    PinOff: icon("PinOff"),
  };
});

vi.mock("@/constants/platform", () => ({
  isNative: false,
  isWeb: true,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  DropdownMenuTrigger: ({
    children,
  }: {
    children?: React.ReactNode | ((state: { hovered: boolean }) => React.ReactNode);
  }) => {
    if (typeof children === "function") {
      return React.createElement(React.Fragment, null, children({ hovered: false }));
    }
    return React.createElement(React.Fragment, null, children);
  },
  DropdownMenuItem: ({
    children,
    testID,
    leading,
  }: {
    children?: React.ReactNode;
    testID?: string;
    leading?: React.ReactNode;
  }) => React.createElement("button", { type: "button", "data-testid": testID }, leading, children),
}));

vi.mock("@/components/ui/shortcut", () => ({
  Shortcut: () => null,
}));

const mockT = vi.fn((key: string) => {
  const map: Record<string, string> = {
    "sidebar.workspace.actions.menu": "Workspace menu",
    "sidebar.workspace.actions.copyPath": "Copy path",
    "sidebar.workspace.actions.copyBranchName": "Copy branch name",
    "sidebar.workspace.actions.rename": "Rename",
    "sidebar.workspace.actions.archive": "Archive",
    "sidebar.workspace.actions.archiving": "Archiving",
    "sidebar.workspace.actions.unpin": "Unpin",
    "sidebar.workspace.actions.pin": "Pin",
  };
  return map[key] ?? key;
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mockT }),
}));

vi.mock("@/constants/platform", () => ({
  isNative: false,
  isWeb: true,
  getIsElectron: vi.fn().mockReturnValue(true),
}));

vi.mock("@/hooks/use-is-local-daemon", () => ({
  useIsLocalDaemon: vi.fn(),
}));

vi.mock("@/workspace/desktop-open-targets", () => ({
  useDesktopOpenTargets: vi.fn(),
  openDesktopTarget: vi.fn(),
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: vi.fn() }),
}));

import { getIsElectron } from "@/constants/platform";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { useDesktopOpenTargets } from "@/workspace/desktop-open-targets";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SidebarWorkspaceMenu", () => {
  const baseProps = {
    workspaceKey: "test-workspace",
    onArchive: vi.fn(),
  };

  const fileManagerTargets = [
    {
      id: "explorer",
      label: "Explorer",
      kind: "file-manager" as const,
      icon: { kind: "symbol" as const, name: "folder" as const },
    },
  ];

  it("renders 'Open in file manager' when workspace is local", () => {
    vi.mocked(getIsElectron).mockReturnValue(true);
    vi.mocked(useIsLocalDaemon).mockReturnValue(true);
    vi.mocked(useDesktopOpenTargets).mockReturnValue({
      targets: fileManagerTargets,
      isAvailable: true,
    });

    const { queryByTestId } = render(
      <SidebarWorkspaceMenu
        {...baseProps}
        serverId="local-server"
        openInFileManagerPath="/some/local/path"
      />,
    );

    expect(queryByTestId("sidebar-workspace-menu-open-folder-test-workspace")).not.toBeNull();
  });

  it("hides 'Open in file manager' when workspace is on a remote host", () => {
    vi.mocked(getIsElectron).mockReturnValue(true);
    vi.mocked(useIsLocalDaemon).mockReturnValue(false);
    vi.mocked(useDesktopOpenTargets).mockReturnValue({
      targets: [],
      isAvailable: false,
    });

    const { queryByTestId } = render(
      <SidebarWorkspaceMenu
        {...baseProps}
        serverId="remote-server"
        openInFileManagerPath="/home/user/project"
      />,
    );

    expect(queryByTestId("sidebar-workspace-menu-open-folder-test-workspace")).toBeNull();
  });

  it("passes serverId to useIsLocalDaemon correctly", () => {
    vi.mocked(getIsElectron).mockReturnValue(true);

    render(
      <SidebarWorkspaceMenu
        {...baseProps}
        serverId="server-abc"
        openInFileManagerPath="/some/path"
      />,
    );

    expect(useIsLocalDaemon).toHaveBeenCalledWith("server-abc");
  });
});
