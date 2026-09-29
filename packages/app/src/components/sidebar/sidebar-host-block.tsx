import { memo, useCallback, type MutableRefObject, type ReactElement } from "react";
import { View } from "react-native";
import type { GestureType } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { isNative } from "@/constants/platform";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import {
  isSidebarHostProjectOrder,
  sidebarProjectSectionKey,
  type SidebarHostGroup,
} from "./sidebar-host-groups";
import { SidebarHostHeader } from "./sidebar-host-header";

export const SidebarHostBlock = memo(function SidebarHostBlock({
  host,
  label,
  collapsed,
  onToggle,
  renderProject,
  onProjectReorder,
  extraData,
  parentGestureRef,
  dragGestureHostActive,
  drag,
  isActive,
  dragHandleProps,
}: {
  host: SidebarHostGroup;
  label: string;
  collapsed: boolean;
  onToggle: (key: string) => void;
  renderProject: (info: DraggableRenderItemInfo<SidebarProjectEntry>) => ReactElement;
  onProjectReorder: (projects: SidebarProjectEntry[]) => void;
  extraData: unknown;
  parentGestureRef?: MutableRefObject<GestureType | undefined>;
  dragGestureHostActive?: boolean;
} & Pick<DraggableRenderItemInfo<SidebarHostGroup>, "drag" | "isActive" | "dragHandleProps">) {
  const handleProjectDragEnd = useCallback(
    (projects: SidebarProjectEntry[]) => {
      if (!isSidebarHostProjectOrder(host, projects)) return;
      onProjectReorder(projects);
    },
    [host, onProjectReorder],
  );

  return (
    <View role="group" accessibilityLabel={label}>
      <SidebarHostHeader
        serverId={host.serverId}
        groupKey={host.key}
        label={label}
        collapsed={collapsed}
        onToggle={onToggle}
        drag={drag}
        isDragging={isActive}
        dragHandleProps={dragHandleProps}
      />
      {collapsed ? null : (
        <View style={styles.hostProjectList}>
          {/* Each host owns its drag context; projects can only reorder inside this list. */}
          <DraggableList
            testID={"sidebar-host-project-list-" + host.serverId}
            data={host.projects}
            keyExtractor={sidebarProjectSectionKey}
            renderItem={renderProject}
            onDragEnd={handleProjectDragEnd}
            extraData={extraData}
            scrollEnabled={false}
            useDragHandle
            nestable={isNative}
            simultaneousGestureRef={parentGestureRef}
            gestureHostPresented={dragGestureHostActive}
            containerStyle={styles.projectListContainer}
          />
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  hostProjectList: {
    paddingLeft: theme.spacing[2],
    marginBottom: theme.spacing[2],
  },
  projectListContainer: {
    width: "100%",
  },
}));
