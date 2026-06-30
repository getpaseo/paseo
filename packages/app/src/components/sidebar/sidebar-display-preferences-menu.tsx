import { useCallback } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Settings2 } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isWeb as platformIsWeb } from "@/constants/platform";
import { useAppSettings, type WorkspaceTitleSource } from "@/hooks/use-settings";
import { useHosts, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useSidebarViewStore, type SidebarGroupMode } from "@/stores/sidebar-view-store";
import { formatConnectionStatus } from "@/utils/daemons";

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

export function SidebarDisplayPreferencesMenu() {
  const groupMode = useSidebarViewStore((state) => state.groupMode);
  const hostFilter = useSidebarViewStore((state) => state.hostFilter);
  const setGroupMode = useSidebarViewStore((state) => state.setGroupMode);
  const setHostFilter = useSidebarViewStore((state) => state.setHostFilter);
  const hosts = useHosts();
  const {
    settings: { workspaceTitleSource },
    updateSettings,
  } = useAppSettings();

  const handleSelectMode = useCallback(
    (mode: SidebarGroupMode) => {
      setGroupMode(mode);
    },
    [setGroupMode],
  );

  const handleSelectHost = useCallback(
    (serverId: string | null) => {
      setHostFilter(serverId);
    },
    [setHostFilter],
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

  const showHostFilter = hosts.length > 1;

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
      <DropdownMenuContent align="end" width={220} testID="sidebar-display-preferences-content">
        <View style={styles.menuHeader}>
          <Text style={styles.menuHeaderLabel}>Group by</Text>
        </View>
        {GROUP_MODE_ITEMS.map((item) => (
          <DisplayPreferenceMenuItem
            key={item.value}
            item={item}
            isSelected={groupMode === item.value}
            testIDPrefix="sidebar-grouping"
            onSelect={handleSelectMode}
          />
        ))}
        {showHostFilter ? (
          <>
            <DropdownMenuSeparator />
            <View style={styles.menuHeader}>
              <Text style={styles.menuHeaderLabel}>Filter</Text>
            </View>
            <HostFilterItem
              label="All hosts"
              value={null}
              hostFilter={hostFilter}
              onSelect={handleSelectHost}
            />
            {hosts.map((host) => (
              <HostFilterItem
                key={host.serverId}
                label={host.label?.trim() || host.serverId}
                serverId={host.serverId}
                value={host.serverId}
                hostFilter={hostFilter}
                onSelect={handleSelectHost}
              />
            ))}
          </>
        ) : null}
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

function HostFilterItem({
  label,
  serverId,
  value,
  hostFilter,
  onSelect,
}: {
  label: string;
  serverId?: string;
  value: string | null;
  hostFilter: string | null;
  onSelect: (serverId: string | null) => void;
}) {
  const isSelected = hostFilter === value;
  const handleSelect = useCallback(() => onSelect(value), [value, onSelect]);
  const status = useHostRuntimeSnapshot(serverId ?? "");
  const subtitle = serverId
    ? formatConnectionStatus(status?.connectionStatus ?? "idle")
    : undefined;

  return (
    <DropdownMenuItem selected={isSelected} description={subtitle} onSelect={handleSelect}>
      {label}
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
