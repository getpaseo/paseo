import { useCallback } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Settings2 } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useSidebarViewStore, type SidebarGroupMode } from "@/stores/sidebar-view-store";
import { isWeb as platformIsWeb } from "@/constants/platform";
import { useAppSettings, type WorkspaceTitleSource } from "@/hooks/use-settings";

const ThemedSettings2 = withUnistyles(Settings2);
const filterColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const GROUP_MODE_ITEMS: Array<{ value: SidebarGroupMode; label: string }> = [
  { value: "project", label: "Project" },
  { value: "status", label: "Status" },
];

const WORKSPACE_TITLE_SOURCE_ITEMS: Array<{ value: WorkspaceTitleSource; label: string }> = [
  { value: "title", label: "Title" },
  { value: "branch", label: "Branch name" },
];

interface DisplayPreferenceOption<Value extends string> {
  value: Value;
  label: string;
}

export function SidebarDisplayPreferencesMenu({ serverId }: { serverId: string | null }) {
  const groupMode = useSidebarViewStore((state) =>
    serverId ? state.getGroupMode(serverId) : "project",
  );
  const setGroupMode = useSidebarViewStore((state) => state.setGroupMode);
  const {
    settings: { workspaceTitleSource },
    updateSettings,
  } = useAppSettings();

  const handleSelect = useCallback(
    (mode: SidebarGroupMode) => {
      if (!serverId) return;
      setGroupMode(serverId, mode);
    },
    [serverId, setGroupMode],
  );

  const handleWorkspaceTitleSourceSelect = useCallback(
    (source: WorkspaceTitleSource) => {
      void updateSettings({ workspaceTitleSource: source });
    },
    [updateSettings],
  );

  const triggerStyle = useCallback(
    ({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.trigger,
      hovered && styles.triggerHovered,
    ],
    [],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={triggerStyle}
        accessibilityRole={platformIsWeb ? undefined : "button"}
        accessibilityLabel="Display preferences"
        testID="sidebar-display-preferences-menu"
      >
        <ThemedSettings2 size={14} uniProps={filterColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={180} testID="sidebar-display-preferences-content">
        <View style={styles.menuHeader}>
          <Text style={styles.menuHeaderLabel}>Group by</Text>
        </View>
        {GROUP_MODE_ITEMS.map((item) => (
          <DisplayPreferenceMenuItem
            key={item.value}
            item={item}
            isSelected={groupMode === item.value}
            testIDPrefix="sidebar-grouping"
            onSelect={handleSelect}
          />
        ))}
        <DropdownMenuSeparator />
        <View style={styles.menuHeader}>
          <Text style={styles.menuHeaderLabel}>Workspace title</Text>
        </View>
        {WORKSPACE_TITLE_SOURCE_ITEMS.map((item) => (
          <DisplayPreferenceMenuItem
            key={item.value}
            item={item}
            isSelected={workspaceTitleSource === item.value}
            testIDPrefix="sidebar-workspace-title-source"
            onSelect={handleWorkspaceTitleSourceSelect}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DisplayPreferenceMenuItem<Value extends string>({
  item,
  isSelected,
  testIDPrefix,
  onSelect,
}: {
  item: DisplayPreferenceOption<Value>;
  isSelected: boolean;
  testIDPrefix: string;
  onSelect: (value: Value) => void;
}) {
  const handleSelect = useCallback(() => onSelect(item.value), [item.value, onSelect]);
  return (
    <DropdownMenuItem
      testID={`${testIDPrefix}-${item.value}`}
      selected={isSelected}
      onSelect={handleSelect}
    >
      <Text style={styles.optionLabel}>{item.label}</Text>
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  menuHeader: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  menuHeaderLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  optionLabel: {
    fontSize: theme.fontSize.sm,
  },
}));
