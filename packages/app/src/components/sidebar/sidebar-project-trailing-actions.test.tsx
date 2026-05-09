/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Pressable, View } from "react-native";
import {
  SidebarProjectTrailingActions,
  type SidebarProjectCreateButtonConfig,
} from "./sidebar-project-trailing-actions";

vi.hoisted(() => {
  Object.assign(globalThis, { __DEV__: false });
});

const { navigateMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
}));

vi.mock("expo-router", () => ({
  router: {
    navigate: navigateMock,
  },
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": name });
  return {
    FolderPlus: createIcon("FolderPlus"),
    MoreVertical: createIcon("MoreVertical"),
    Plus: createIcon("Plus"),
    Settings: createIcon("Settings"),
    Trash2: createIcon("Trash2"),
  };
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (styles: unknown) =>
      typeof styles === "function"
        ? styles({
            borderRadius: { md: 6 },
            colors: {
              foreground: "#111111",
              foregroundMuted: "#666666",
              surface2: "#eeeeee",
              surfaceSidebarHover: "#f5f5f5",
            },
            fontSize: { sm: 14 },
            spacing: { 2: 8 },
          })
        : styles,
  },
  withUnistyles: (Component: React.ComponentType<Record<string, unknown>>) =>
    function ThemedComponent(props: Record<string, unknown>) {
      return <Component {...props} />;
    },
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
  DropdownMenuItem: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <View testID={testID}>{children}</View>
  ),
  DropdownMenuTrigger: ({
    children,
    testID,
  }: {
    children: React.ReactNode | ((state: { hovered: boolean }) => React.ReactNode);
    testID?: string;
  }) => (
    <Pressable testID={testID}>
      {typeof children === "function" ? children({ hovered: false }) : children}
    </Pressable>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/components/ui/shortcut", () => ({
  Shortcut: () => <View />,
}));

vi.mock("@/constants/platform", () => ({
  isNative: false,
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => false,
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: vi.fn() }),
}));

vi.mock("@/hooks/use-shortcut-keys", () => ({
  useShortcutKeys: () => null,
}));

afterEach(() => {
  cleanup();
  navigateMock.mockClear();
});

const newWorkspaceCreateButton: SidebarProjectCreateButtonConfig = {
  onPress: () => {},
  accessibilityLabel: "New workspace",
  testID: "sidebar-project-new-worktree-project-a",
  tooltipLabel: "New workspace",
  icon: "folder-plus",
};

describe("SidebarProjectTrailingActions", () => {
  it("renders the kebab and create button when configured", () => {
    const { getByTestId } = render(
      <SidebarProjectTrailingActions
        projectKey="project-a"
        projectName="Project A"
        serverId="server-1"
        isHovered
        createButton={newWorkspaceCreateButton}
        onRemoveProject={vi.fn()}
      />,
    );

    expect(getByTestId("sidebar-project-kebab-project-a")).toBeTruthy();
    expect(getByTestId("sidebar-project-new-worktree-project-a")).toBeTruthy();
  });

  it("renders only the kebab when createButton is null", () => {
    const { getByTestId, queryByTestId } = render(
      <SidebarProjectTrailingActions
        projectKey="project-a"
        projectName="Project A"
        serverId="server-1"
        isHovered
        createButton={null}
        onRemoveProject={vi.fn()}
      />,
    );

    expect(getByTestId("sidebar-project-kebab-project-a")).toBeTruthy();
    expect(queryByTestId("sidebar-project-new-worktree-project-a")).toBeNull();
  });

  it("uses the create button override instead of the default route", () => {
    const createOnPress = vi.fn();

    function Harness() {
      const createButton = React.useMemo(
        () => ({
          onPress: createOnPress,
          accessibilityLabel: "New session",
          testID: "sidebar-project-project-a-new-session-button",
          tooltipLabel: "New session",
          icon: "plus" as const,
        }),
        [],
      );

      return (
        <SidebarProjectTrailingActions
          projectKey="project-a"
          projectName="Project A"
          serverId="server-1"
          isHovered
          createButton={createButton}
          onRemoveProject={vi.fn()}
        />
      );
    }

    const { getByTestId } = render(<Harness />);

    fireEvent.click(getByTestId("sidebar-project-project-a-new-session-button"));

    expect(createOnPress).toHaveBeenCalledOnce();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
