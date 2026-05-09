import React, { useCallback, type MutableRefObject, type ReactElement } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import type { GestureType } from "react-native-gesture-handler";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { hasVisibleOrderChanged, mergeWithRemainder } from "@/utils/sidebar-reorder";

export interface SidebarProjectDragInfo {
  project: SidebarProjectEntry;
  drag: () => void;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}

interface SidebarProjectsDraggableListProps {
  projects: readonly SidebarProjectEntry[];
  serverId: string | null;
  renderProject: (info: SidebarProjectDragInfo) => ReactElement;
  /** Native: use the nestable variant when wrapped in a NestableScrollContainer. */
  nestable?: boolean;
  /** When false, the outer scroll container owns scrolling. */
  scrollEnabled?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  testID?: string;
  /** Native: gesture ref to coordinate with parent (e.g. sidebar close swipe). */
  simultaneousGestureRef?: MutableRefObject<GestureType | undefined>;
}

const projectKeyExtractor = (project: SidebarProjectEntry) => project.projectKey;

export function SidebarProjectsDraggableList({
  projects,
  serverId,
  renderProject,
  nestable = false,
  scrollEnabled = false,
  containerStyle,
  testID,
  simultaneousGestureRef,
}: SidebarProjectsDraggableListProps): ReactElement {
  const getProjectOrder = useSidebarOrderStore((state) => state.getProjectOrder);
  const setProjectOrder = useSidebarOrderStore((state) => state.setProjectOrder);

  const handleDragEnd = useCallback(
    (reorderedProjects: SidebarProjectEntry[]) => {
      if (!serverId) {
        return;
      }
      const reorderedProjectKeys = reorderedProjects.map((project) => project.projectKey);
      const currentProjectOrder = getProjectOrder(serverId);
      if (
        !hasVisibleOrderChanged({
          currentOrder: currentProjectOrder,
          reorderedVisibleKeys: reorderedProjectKeys,
        })
      ) {
        return;
      }
      setProjectOrder(
        serverId,
        mergeWithRemainder({
          currentOrder: currentProjectOrder,
          reorderedVisibleKeys: reorderedProjectKeys,
        }),
      );
    },
    [getProjectOrder, serverId, setProjectOrder],
  );

  const renderItem = useCallback(
    ({ item, drag, isActive, dragHandleProps }: DraggableRenderItemInfo<SidebarProjectEntry>) =>
      renderProject({ project: item, drag, isDragging: isActive, dragHandleProps }),
    [renderProject],
  );

  return (
    <DraggableList
      testID={testID}
      data={projects as SidebarProjectEntry[]}
      keyExtractor={projectKeyExtractor}
      renderItem={renderItem}
      onDragEnd={handleDragEnd}
      scrollEnabled={scrollEnabled}
      useDragHandle
      nestable={nestable}
      simultaneousGestureRef={simultaneousGestureRef}
      containerStyle={containerStyle}
    />
  );
}
