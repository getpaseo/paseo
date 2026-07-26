import { useCallback, useMemo } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useSidebarViewStore, type SidebarGroupMode } from "@/stores/sidebar-view-store";

const OPTIONS: Array<{ value: SidebarGroupMode; label: string; testID: string }> = [
  { value: "project", label: "Project", testID: "sidebar-group-mode-project" },
  { value: "status", label: "Status", testID: "sidebar-group-mode-status" },
];

/**
 * Obvious Project | Status control so Status grouping is not buried in the gear menu.
 */
export function SidebarGroupModeControl() {
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

  return (
    <View style={styles.wrap} testID="sidebar-group-mode-control">
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
  wrap: {
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
}));
