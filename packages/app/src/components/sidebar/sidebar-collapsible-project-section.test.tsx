/**
 * @vitest-environment jsdom
 */
import { cleanup, render } from "@testing-library/react";
import React from "react";
import { Text } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarProjectSection } from "./sidebar-collapsible-project-section";

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": name });
  return {
    ChevronDown: createIcon("ChevronDown"),
    ChevronRight: createIcon("ChevronRight"),
  };
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (styles: unknown) =>
      typeof styles === "function"
        ? styles({
            borderRadius: { lg: 8 },
            colors: {
              border: "#dddddd",
              surface2: "#eeeeee",
              surfaceSidebarHover: "#f5f5f5",
            },
            iconSize: { md: 16 },
            shadow: { md: {} },
            spacing: { 1: 4, 2: 8, 3: 12 },
          })
        : styles,
  },
}));

vi.mock("@/components/sidebar/sidebar-project-row-visual", () => ({
  SidebarProjectIcon: ({ projectName }: { projectName: string }) => <Text>{projectName}</Text>,
  SidebarProjectRowVisual: ({ projectName }: { projectName: string }) => <Text>{projectName}</Text>,
}));

afterEach(cleanup);

const collapsedFooter = <Text>Footer row</Text>;

describe("SidebarProjectSection", () => {
  it("renders the header and expanded children", () => {
    const { getByTestId, getByText } = render(
      <SidebarProjectSection
        projectKey="project-a"
        projectName="Project A"
        iconDataUri={null}
        onPress={vi.fn()}
        isHovered={false}
        chevron="collapse"
        isCollapsed={false}
        testID="project-a-header"
      >
        <Text>Child row</Text>
      </SidebarProjectSection>,
    );

    expect(getByTestId("project-a-header")).toBeTruthy();
    expect(getByText("Project A")).toBeTruthy();
    expect(getByText("Child row")).toBeTruthy();
  });

  it("keeps the header visible and hides children plus footer when collapsed", () => {
    const { getByTestId, queryByText } = render(
      <SidebarProjectSection
        projectKey="project-a"
        projectName="Project A"
        iconDataUri={null}
        onPress={vi.fn()}
        isHovered={false}
        chevron="expand"
        isCollapsed
        footer={collapsedFooter}
        testID="project-a-header"
      >
        <Text>Child row</Text>
      </SidebarProjectSection>,
    );

    expect(getByTestId("project-a-header")).toBeTruthy();
    expect(queryByText("Child row")).toBeNull();
    expect(queryByText("Footer row")).toBeNull();
  });
});
