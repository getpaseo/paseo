/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import React from "react";
import { Pressable, Text, View } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarSessionRowKebabMenu } from "./session-row-actions";

vi.hoisted(() => {
  Object.assign(globalThis, { __DEV__: false });
});

const { archiveAgentMock, platformState } = vi.hoisted(() => ({
  archiveAgentMock: vi.fn(),
  platformState: { isNative: false },
}));

vi.mock("@/hooks/use-archive-agent", () => ({
  useArchiveAgent: () => ({
    archiveAgent: archiveAgentMock,
    isArchivingAgent: () => false,
  }),
}));

vi.mock("@/constants/platform", () => ({
  get isNative() {
    return platformState.isNative;
  },
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
  DropdownMenuItem: ({
    children,
    onSelect,
    testID,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    testID?: string;
  }) => (
    <Pressable testID={testID} onPress={onSelect}>
      <Text>{children}</Text>
    </Pressable>
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

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) =>
    function Icon({ uniProps: _uniProps, ...props }: Record<string, unknown>) {
      return React.createElement("span", { ...props, "data-icon": name });
    };
  return {
    Archive: createIcon("Archive"),
    MoreVertical: createIcon("MoreVertical"),
  };
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (styles: unknown) =>
      typeof styles === "function"
        ? styles({
            colors: {
              foreground: "#111111",
              foregroundMuted: "#666666",
              surface2: "#eeeeee",
            },
            fontSize: { xs: 12 },
          })
        : styles,
  },
  withUnistyles: (Component: React.ComponentType<Record<string, unknown>>) =>
    function ThemedComponent(props: Record<string, unknown>) {
      return <Component {...props} />;
    },
}));

const SERVER_ID = "server-1";
const AGENT_ID = "agent-1";

beforeEach(() => {
  archiveAgentMock.mockReset();
  archiveAgentMock.mockResolvedValue(undefined);
  platformState.isNative = false;
});

afterEach(() => {
  cleanup();
});

describe("SidebarSessionRowKebabMenu", () => {
  it("renders when hovered and hides on non-touch idle rows", () => {
    const hidden = render(
      <SidebarSessionRowKebabMenu serverId={SERVER_ID} agentId={AGENT_ID} isHovered={false} />,
    );
    expect(hidden.queryByTestId(`sidebar-session-kebab-${SERVER_ID}-${AGENT_ID}`)).toBeNull();
    hidden.unmount();

    const visible = render(
      <SidebarSessionRowKebabMenu serverId={SERVER_ID} agentId={AGENT_ID} isHovered />,
    );
    expect(visible.getByTestId(`sidebar-session-kebab-${SERVER_ID}-${AGENT_ID}`)).toBeTruthy();
  });

  it("renders on touch platforms without hover", () => {
    platformState.isNative = true;

    const { getByTestId } = render(
      <SidebarSessionRowKebabMenu serverId={SERVER_ID} agentId={AGENT_ID} isHovered={false} />,
    );

    expect(getByTestId(`sidebar-session-kebab-${SERVER_ID}-${AGENT_ID}`)).toBeTruthy();
  });

  it("archives the agent from the archive item", () => {
    const { getAllByTestId, getByTestId, queryByTestId } = render(
      <SidebarSessionRowKebabMenu serverId={SERVER_ID} agentId={AGENT_ID} isHovered />,
    );

    expect(getAllByTestId(/^sidebar-session-menu-server-1-agent-1-/)).toHaveLength(1);
    expect(queryByTestId(`sidebar-session-menu-${SERVER_ID}-${AGENT_ID}-close`)).toBeNull();

    fireEvent.click(getByTestId(`sidebar-session-menu-${SERVER_ID}-${AGENT_ID}-archive`));

    expect(archiveAgentMock).toHaveBeenCalledWith({ serverId: SERVER_ID, agentId: AGENT_ID });
  });
});
