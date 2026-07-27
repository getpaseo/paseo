import { useCallback, useMemo } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useSidebarViewStore, type SidebarGroupMode } from "@/stores/sidebar-view-store";

const OPTIONS: Array<{ value: SidebarGroupMode; label: string; testID: string }> = [
  { value: "project", label: "Project", testID: "sidebar-group-mode-project" },
  { value: "status", label: "Status", testID: "sidebar-group-mode-status" },
];

interface SidebarGroupModeControlProps {
  /** Hide when the Workspaces header is too narrow; gear menu still has Group by. */
  visible?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * Inline Project | Status control for the Workspaces header row.
 * Gear → Group by remains the always-available fallback.
 */
export function SidebarGroupModeControl({ visible = true, style }: SidebarGroupModeControlProps) {
  const groupMode = useSidebarViewStore((state) => state.groupMode);
  const setGroupMode = useSidebarViewStore((state) => state.setGroupMode);

  const options = useMemo(
    () =>
      OPTIONS.map((item) => ({
        value: item.value,
        label: item.label,
        testID: item.testID,
      })),
    [],
  );

  const handleChange = useCallback(
    (mode: SidebarGroupMode) => {
      setGroupMode(mode);
    },
    [setGroupMode],
  );

  if (!visible) {
    return null;
  }

  return (
    <View style={[styles.row, style]} testID="sidebar-group-mode-control">
      <Text style={styles.byLabel} numberOfLines={1}>
        by
      </Text>
      <SegmentedControl
        options={options}
        value={groupMode}
        onValueChange={handleChange}
        size="xs"
        testID="sidebar-group-mode-segmented"
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flexShrink: 1,
    minWidth: 0,
  },
  byLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    textTransform: "lowercase",
    flexShrink: 0,
  },
}));
