import { useCallback, useMemo, type Ref } from "react";
import { View, Text, type PressableStateCallbackType } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HostStatusDot } from "@/components/host-status-dot";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import { useLongPressDragInteraction } from "./use-long-press-drag-interaction";
import type { Theme } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const headerStyle = ({ hovered }: PressableStateCallbackType) => [
  styles.header,
  hovered && styles.hovered,
];

export function SidebarHostHeader({
  serverId,
  groupKey,
  label,
  collapsed,
  onToggle,
  drag,
  isDragging,
  dragHandleProps,
}: {
  serverId: string;
  groupKey: string;
  label: string;
  collapsed: boolean;
  onToggle: (key: string) => void;
  drag: () => void;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}) {
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  const interaction = useLongPressDragInteraction({ drag, menuController: null });
  const handlePress = useCallback(() => {
    if (interaction.didLongPressRef.current) {
      interaction.didLongPressRef.current = false;
      return;
    }
    if (!isDragging) onToggle(groupKey);
  }, [groupKey, onToggle, isDragging, interaction.didLongPressRef]);
  const {
    role: _dragRole,
    tabIndex: _dragTabIndex,
    "aria-roledescription": _dragRoleDescription,
    ...dragAttributes
  } = dragHandleProps?.attributes ?? {};
  const Chevron = collapsed ? ThemedChevronRight : ThemedChevronDown;
  return (
    <View
      {...dragAttributes}
      {...dragHandleProps?.listeners}
      ref={dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>}
    >
      <PressHighlight
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={accessibilityState}
        aria-expanded={!collapsed}
        onPress={handlePress}
        onPressIn={interaction.handlePressIn}
        onTouchMove={interaction.handleTouchMove}
        onPressOut={interaction.handlePressOut}
        testID={"sidebar-host-header-" + serverId}
        style={headerStyle}
        highlightStyle={styles.hovered}
      >
        <Chevron size={12} uniProps={foregroundMutedColorMapping} />
        <Text numberOfLines={1} style={styles.title}>
          {label}
        </Text>
        <HostStatusDot serverId={serverId} />
      </PressHighlight>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginHorizontal: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    userSelect: "none",
  },
  hovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  title: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
}));
