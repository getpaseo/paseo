/**
 * @vitest-environment jsdom
 */
import { render } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import {
  SidebarProjectsDraggableList,
  type SidebarProjectDragInfo,
} from "./sidebar-projects-draggable-list";

interface CapturedDraggableProps {
  data: SidebarProjectEntry[];
  onDragEnd: (next: SidebarProjectEntry[]) => void;
}

const captured: { props: CapturedDraggableProps | null } = { props: null };

vi.mock("@/components/draggable-list", () => ({
  DraggableList: (props: CapturedDraggableProps) => {
    captured.props = props;
    return null;
  },
}));

function makeProject(key: string): SidebarProjectEntry {
  return {
    projectKey: key,
    projectName: key,
    projectKind: "git",
    iconWorkingDir: `/repo/${key}`,
    workspaces: [],
  };
}

const PROJECTS_ABC: readonly SidebarProjectEntry[] = [
  makeProject("a"),
  makeProject("b"),
  makeProject("c"),
];

const PROJECTS_AB: readonly SidebarProjectEntry[] = [makeProject("a"), makeProject("b")];

function renderEmpty(): React.ReactElement {
  return React.createElement(React.Fragment);
}

afterEach(() => {
  captured.props = null;
  useSidebarOrderStore.setState({
    projectOrderByServerId: {},
    workspaceOrderByServerAndProject: {},
  });
});

const noopRender = (_info: SidebarProjectDragInfo): React.ReactElement => renderEmpty();

describe("SidebarProjectsDraggableList", () => {
  it("persists the reordered project keys to the order store on drag end", () => {
    render(
      <SidebarProjectsDraggableList
        projects={PROJECTS_ABC}
        serverId="server-1"
        renderProject={noopRender}
      />,
    );

    expect(captured.props).not.toBeNull();
    const reordered = [PROJECTS_ABC[1], PROJECTS_ABC[0], PROJECTS_ABC[2]];
    captured.props?.onDragEnd(reordered);

    expect(useSidebarOrderStore.getState().getProjectOrder("server-1")).toEqual(["b", "a", "c"]);
  });

  it("does not persist when the reordered visible keys match the current order", () => {
    useSidebarOrderStore.getState().setProjectOrder("server-1", ["a", "b"]);
    const setSpy = vi.spyOn(useSidebarOrderStore.getState(), "setProjectOrder");

    render(
      <SidebarProjectsDraggableList
        projects={PROJECTS_AB}
        serverId="server-1"
        renderProject={noopRender}
      />,
    );

    captured.props?.onDragEnd([...PROJECTS_AB]);

    expect(setSpy).not.toHaveBeenCalled();
  });

  it("does nothing when serverId is null", () => {
    render(
      <SidebarProjectsDraggableList
        projects={PROJECTS_AB}
        serverId={null}
        renderProject={noopRender}
      />,
    );

    captured.props?.onDragEnd([PROJECTS_AB[1], PROJECTS_AB[0]]);

    expect(useSidebarOrderStore.getState().projectOrderByServerId).toEqual({});
  });
});
