import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
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
import { HostStatusDot } from "@/components/host-status-dot";
import { isWeb as platformIsWeb } from "@/constants/platform";
import { useAppSettings, type WorkspaceTitleSource } from "@/hooks/use-settings";
import { useHosts } from "@/runtime/host-runtime";
import { useSidebarViewStore, type SidebarGroupMode } from "@/stores/sidebar-view-store";

// Prefer withUnistyles mappings over uniProps — lucide forwards unknown props to
// SVG <path> on web, which logs React DOM warnings for `uniProps`.
const ThemedSettings2 = withUnistyles(Settings2, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));

interface DisplayPreferenceOption<Value extends string> {
  value: Value;
  label: string;
}

export function SidebarDisplayPreferencesMenu() {
  const { t } = useTranslation();
  const groupMode = useSidebarViewStore((state) => state.groupMode);
  const hostFilters = useSidebarViewStore((state) => state.hostFilters);
  const setGroupMode = useSidebarViewStore((state) => state.setGroupMode);
  const toggleHostFilter = useSidebarViewStore((state) => state.toggleHostFilter);
  const clearHostFilters = useSidebarViewStore((state) => state.clearHostFilters);
  const hosts = useHosts();
  const {
    settings: { workspaceTitleSource, showSidebarProjectIcons },
    updateSettings,
  } = useAppSettings();

  const groupModeItems = useMemo<Array<{ value: SidebarGroupMode; label: string }>>(
    () => [
      { value: "project", label: t("sidebar.workspace.groupByProject") },
      { value: "status", label: t("sidebar.workspace.groupByStatus") },
    ],
    [t],
  );

  const workspaceTitleSourceItems = useMemo<Array<{ value: WorkspaceTitleSource; label: string }>>(
    () => [
      { value: "title", label: t("sidebar.workspace.titleSource") },
      { value: "branch", label: t("sidebar.workspace.branchSource") },
    ],
    [t],
  );

  const projectIconVisibilityItems = useMemo<Array<{ value: "show" | "hide"; label: string }>>(
    () => [
      { value: "show", label: t("sidebar.workspace.projectIconsShow") },
      { value: "hide", label: t("sidebar.workspace.projectIconsHide") },
    ],
    [t],
  );

  const handleSelectMode = useCallback(
    (mode: SidebarGroupMode) => {
      setGroupMode(mode);
    },
    [setGroupMode],
  );

  const handleWorkspaceTitleSourceSelect = useCallback(
    (source: WorkspaceTitleSource) => {
      void updateSettings({ workspaceTitleSource: source });
    },
    [updateSettings],
  );

  const handleProjectIconVisibilitySelect = useCallback(
    (value: "show" | "hide") => {
      void updateSettings({ showSidebarProjectIcons: value === "show" });
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
  const allHostsSelected = hostFilters.length === 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={triggerStyle}
        accessibilityRole={platformIsWeb ? undefined : "button"}
        accessibilityLabel={t("sidebar.workspace.displayPreferences")}
        testID="sidebar-display-preferences-menu"
      >
        <ThemedSettings2 size={14} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220} testID="sidebar-display-preferences-content">
        <View style={styles.menuHeader}>
          <Text style={styles.menuHeaderLabel}>{t("sidebar.workspace.groupBy")}</Text>
        </View>
        {groupModeItems.map((item) => (
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
              <Text style={styles.menuHeaderLabel}>{t("sidebar.workspace.filter")}</Text>
            </View>
            <DropdownMenuItem
              testID="sidebar-host-filter-all"
              selected={allHostsSelected}
              closeOnSelect={false}
              onSelect={clearHostFilters}
            >
              {t("sidebar.workspace.allHosts")}
            </DropdownMenuItem>
            {hosts.map((host) => (
              <HostFilterItem
                key={host.serverId}
                label={host.label?.trim() || host.serverId}
                serverId={host.serverId}
                selected={hostFilters.includes(host.serverId)}
                onToggle={toggleHostFilter}
              />
            ))}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <View style={styles.menuHeader}>
          <Text style={styles.menuHeaderLabel}>{t("sidebar.workspace.workspaceTitle")}</Text>
        </View>
        {workspaceTitleSourceItems.map((item) => (
          <DisplayPreferenceMenuItem
            key={item.value}
            item={item}
            isSelected={workspaceTitleSource === item.value}
            testIDPrefix="sidebar-workspace-title-source"
            onSelect={handleWorkspaceTitleSourceSelect}
          />
        ))}
        <DropdownMenuSeparator />
        <View style={styles.menuHeader}>
          <Text style={styles.menuHeaderLabel}>{t("sidebar.workspace.projectIcons")}</Text>
        </View>
        {projectIconVisibilityItems.map((item) => (
          <DisplayPreferenceMenuItem
            key={item.value}
            item={item}
            isSelected={item.value === "show" ? showSidebarProjectIcons : !showSidebarProjectIcons}
            testIDPrefix="sidebar-project-icons"
            onSelect={handleProjectIconVisibilitySelect}
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
  selected,
  onToggle,
}: {
  label: string;
  serverId: string;
  selected: boolean;
  onToggle: (serverId: string) => void;
}) {
  const handleSelect = useCallback(() => onToggle(serverId), [serverId, onToggle]);
  const leading = useMemo(
    () => (
      <View testID={`sidebar-host-filter-status-${serverId}`}>
        <HostStatusDot serverId={serverId} />
      </View>
    ),
    [serverId],
  );

  return (
    <DropdownMenuItem
      testID={`sidebar-host-filter-${serverId}`}
      selected={selected}
      closeOnSelect={false}
      leading={leading}
      onSelect={handleSelect}
    >
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
