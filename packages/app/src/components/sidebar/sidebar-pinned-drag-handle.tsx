import { useCallback, useState, type ReactElement, type ReactNode } from "react";
import { View } from "react-native";
import { GripVertical } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { isNative, isWeb } from "@/constants/platform";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";

const ThemedGripVertical = withUnistyles(GripVertical);
const gripColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function isPinnedDragHandleVisible(input: {
  hovered: boolean;
  dragging: boolean;
  alwaysVisible: boolean;
}): boolean {
  return input.alwaysVisible || input.hovered || input.dragging;
}

export function SidebarPinnedDragHandle({
  workspaceKey,
  dragHandleProps,
  visible,
}: {
  workspaceKey: string;
  dragHandleProps?: DraggableListDragHandleProps;
  visible: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const {
    role: _dragRole,
    tabIndex: _dragTabIndex,
    "aria-roledescription": _dragRoleDescription,
    ...dragAttributes
  } = dragHandleProps?.attributes ?? {};

  return (
    <View
      {...dragAttributes}
      {...dragHandleProps?.listeners}
      ref={dragHandleProps?.setActivatorNodeRef as never}
      accessibilityRole="adjustable"
      accessibilityLabel={t("sidebar.pinned.reorder")}
      testID={`sidebar-pinned-drag-handle-${workspaceKey}`}
      style={[styles.handle, visible ? styles.handleVisible : styles.handleHidden]}
    >
      <ThemedGripVertical size={12} uniProps={gripColor} />
    </View>
  );
}

export function PinnedDraggableRowChrome({
  workspaceKey,
  dragHandleProps,
  isDragging,
  children,
}: {
  workspaceKey: string;
  dragHandleProps?: DraggableListDragHandleProps;
  isDragging: boolean;
  children: ReactNode;
}): ReactElement {
  const [hovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);

  return (
    <View
      style={styles.row}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <SidebarPinnedDragHandle
        workspaceKey={workspaceKey}
        dragHandleProps={dragHandleProps}
        visible={isPinnedDragHandleVisible({
          hovered,
          dragging: isDragging,
          alwaysVisible: isNative,
        })}
      />
      <View style={styles.body}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    minWidth: 0,
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  handle: {
    width: theme.spacing[4],
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    ...(isWeb ? { cursor: "grab" } : null),
  },
  handleVisible: {
    opacity: 1,
  },
  handleHidden: {
    opacity: 0,
  },
}));
