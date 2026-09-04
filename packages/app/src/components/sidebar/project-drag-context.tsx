import type { ReactElement, ReactNode, Ref } from "react";
import type { StyleProp, View, ViewStyle } from "react-native";
import type { SidebarProjectGroup } from "@/components/sidebar/sidebar-projection";
import type { ProjectDropResolution } from "@/components/sidebar/project-drop-resolution";

/**
 * Native and TypeScript resolution of the sidebar's project and group drags.
 *
 * Native drag lists cannot drag across each other, so there is nothing to host here: the
 * provider renders its children, the hooks report "no drag", and the drop targets render
 * nothing. The web file (`project-drag-context.web.tsx`) is the real one.
 */

export type ProjectDragActive =
  | { kind: "row"; viewKey: string; groupKey: string | null }
  | { kind: "group"; groupKey: string };

export interface ProjectDropPreview {
  anchorViewKey: string;
  placement: "before" | "after";
}

export interface ProjectDropInput {
  activeViewKey: string;
  resolution: ProjectDropResolution;
}

export interface ProjectGroupReorderInput {
  activeGroupKey: string;
  overGroupKey: string;
}

export interface ProjectDragContextProps {
  children: ReactNode;
  onDrop: (input: ProjectDropInput) => void;
  onGroupReorder: (input: ProjectGroupReorderInput) => void;
  renderOverlay: (active: ProjectDragActive) => ReactNode;
}

/** What a group header spreads on its toggle so a press-and-drag on it moves the whole group. */
export interface ProjectGroupDragHandle {
  setActivatorNodeRef: Ref<View>;
  listeners: Record<string, unknown>;
}

export interface ProjectGroupSortable {
  setNodeRef: Ref<View> | undefined;
  style: StyleProp<ViewStyle>;
  dragHandle: ProjectGroupDragHandle | undefined;
}

export function ProjectDragContext({ children }: ProjectDragContextProps): ReactNode {
  return children;
}

export function useProjectDragActive(): ProjectDragActive | null {
  return null;
}

export function useProjectGroupHeaderDroppable(_group: SidebarProjectGroup): {
  setNodeRef: undefined;
  isOver: boolean;
} {
  return { setNodeRef: undefined, isOver: false };
}

export function ProjectGroupSortableContext(props: {
  groupKeys: readonly string[];
  children: ReactNode;
}): ReactNode {
  return props.children;
}

export function useProjectGroupSortable(_group: SidebarProjectGroup): ProjectGroupSortable {
  return { setNodeRef: undefined, style: undefined, dragHandle: undefined };
}

export function ProjectDropZones(): ReactElement | null {
  return null;
}

export function ProjectRowDropIndicator(_props: { viewKey: string }): ReactElement | null {
  return null;
}
