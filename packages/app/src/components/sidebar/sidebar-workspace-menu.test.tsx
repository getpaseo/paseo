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

// Mock OpenInFileManagerMenuItem so we can assert on its props.
const OpenInFileManagerMenuItemSpy = vi.fn((_props: Record<string, unknown>) =>
  React.createElement(
    "span",
    { "data-testid": "open-in-file-manager-item" },
    "Open in file manager",
  ),
);

vi.mock("@/workspace/open-in-file-manager/menu-item", () => ({
  OpenInFileManagerMenuItem: (props: Record<string, unknown>) =>
    OpenInFileManagerMenuItemSpy(props),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SidebarWorkspaceMenu", () => {
  const baseProps = {
    workspaceKey: "test-workspace",
    onArchive: vi.fn(),
  };

  it("forwards serverId to OpenInFileManagerMenuItem", () => {
    render(
      <SidebarWorkspaceMenu
        {...baseProps}
        serverId="server-abc"
        openInFileManagerPath="/some/path"
      />,
    );

    expect(OpenInFileManagerMenuItemSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "server-abc",
        path: "/some/path",
      }),
    );
  });

  it("forwards null serverId to OpenInFileManagerMenuItem", () => {
    render(
      <SidebarWorkspaceMenu {...baseProps} serverId={null} openInFileManagerPath="/some/path" />,
    );

    expect(OpenInFileManagerMenuItemSpy).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: null }),
    );
  });

  it("forwards undefined serverId when not provided", () => {
    render(<SidebarWorkspaceMenu {...baseProps} openInFileManagerPath="/some/path" />);

    expect(OpenInFileManagerMenuItemSpy).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: undefined }),
    );
  });

  it("forwards path as undefined when openInFileManagerPath is not set", () => {
    render(<SidebarWorkspaceMenu {...baseProps} serverId="server-abc" />);

    expect(OpenInFileManagerMenuItemSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "server-abc",
        path: undefined,
      }),
    );
  });
});
