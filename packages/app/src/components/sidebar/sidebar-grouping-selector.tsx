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
import { useAppSettings } from "@/hooks/use-settings";
import {
  useSidebarViewStore,
  type SidebarEmbeddedRecentTabCount,
  type SidebarEmbeddedTabSortMode,
  type SidebarGroupMode,
} from "@/stores/sidebar-view-store";
import { isWeb as platformIsWeb } from "@/constants/platform";

const ThemedSettings2 = withUnistyles(Settings2);
const filterColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const GROUP_MODE_ITEMS: Array<{ value: SidebarGroupMode; label: string }> = [
  { value: "project", label: "Project" },
  { value: "status", label: "Status" },
];

const TAB_SORT_ITEMS: Array<{ value: SidebarEmbeddedTabSortMode; label: string }> = [
  { value: "manual", label: "Manual" },
  { value: "created", label: "Created" },
  { value: "lastUpdated", label: "Last updated" },
];

const RECENT_TAB_COUNT_ITEMS: Array<{ value: SidebarEmbeddedRecentTabCount; label: string }> = [
  { value: 3, label: "3" },
  { value: 5, label: "5" },
  { value: 10, label: "10" },
  { value: "all", label: "All" },
];

export function SidebarGroupingSelector({ serverId }: { serverId: string | null }) {
  const { settings } = useAppSettings();
  const groupMode = useSidebarViewStore((state) =>
    serverId ? state.getGroupMode(serverId) : "project",
  );
  const tabSortMode = useSidebarViewStore((state) =>
    serverId ? state.getEmbeddedTabSortMode(serverId) : "manual",
  );
  const recentTabCount = useSidebarViewStore((state) =>
    serverId ? state.getEmbeddedRecentTabCount(serverId) : 5,
  );
  const setGroupMode = useSidebarViewStore((state) => state.setGroupMode);
  const setTabSortMode = useSidebarViewStore((state) => state.setEmbeddedTabSortMode);
  const setRecentTabCount = useSidebarViewStore((state) => state.setEmbeddedRecentTabCount);

  const handleSelect = useCallback(
    (mode: SidebarGroupMode) => {
      if (!serverId) return;
      setGroupMode(serverId, mode);
    },
    [serverId, setGroupMode],
  );

  const handleTabSortSelect = useCallback(
    (mode: SidebarEmbeddedTabSortMode) => {
      if (!serverId) return;
      setTabSortMode(serverId, mode);
    },
    [serverId, setTabSortMode],
  );

  const handleRecentTabCountSelect = useCallback(
    (count: SidebarEmbeddedRecentTabCount) => {
      if (!serverId) return;
      setRecentTabCount(serverId, count);
    },
    [serverId, setRecentTabCount],
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
        accessibilityLabel="Sidebar grouping"
        testID="sidebar-grouping-selector"
      >
        <ThemedSettings2 size={14} uniProps={filterColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" width={180} testID="sidebar-grouping-menu">
        <View style={styles.menuHeader}>
          <Text style={styles.menuHeaderLabel}>Group by</Text>
        </View>
        {GROUP_MODE_ITEMS.map((item) => (
          <GroupModeMenuItem
            key={item.value}
            item={item}
            isSelected={groupMode === item.value}
            onSelect={handleSelect}
          />
        ))}
        {settings.embeddedTabs ? (
          <>
            <DropdownMenuSeparator />
            <View style={styles.menuHeader}>
              <Text style={styles.menuHeaderLabel}>Tab sort</Text>
            </View>
            {TAB_SORT_ITEMS.map((item) => (
              <TabSortMenuItem
                key={item.value}
                item={item}
                isSelected={tabSortMode === item.value}
                onSelect={handleTabSortSelect}
              />
            ))}
            <DropdownMenuSeparator />
            <View style={styles.menuHeader}>
              <Text style={styles.menuHeaderLabel}>Recent tab count</Text>
            </View>
            {RECENT_TAB_COUNT_ITEMS.map((item) => (
              <RecentTabCountMenuItem
                key={String(item.value)}
                item={item}
                isSelected={recentTabCount === item.value}
                onSelect={handleRecentTabCountSelect}
              />
            ))}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function GroupModeMenuItem({
  item,
  isSelected,
  onSelect,
}: {
  item: { value: SidebarGroupMode; label: string };
  isSelected: boolean;
  onSelect: (mode: SidebarGroupMode) => void;
}) {
  const handleSelect = useCallback(() => onSelect(item.value), [item.value, onSelect]);
  return (
    <DropdownMenuItem
      testID={`sidebar-grouping-${item.value}`}
      selected={isSelected}
      onSelect={handleSelect}
    >
      {item.label}
    </DropdownMenuItem>
  );
}

function TabSortMenuItem({
  item,
  isSelected,
  onSelect,
}: {
  item: { value: SidebarEmbeddedTabSortMode; label: string };
  isSelected: boolean;
  onSelect: (mode: SidebarEmbeddedTabSortMode) => void;
}) {
  const handleSelect = useCallback(() => onSelect(item.value), [item.value, onSelect]);
  return (
    <DropdownMenuItem
      testID={`sidebar-tab-sort-${item.value}`}
      selected={isSelected}
      onSelect={handleSelect}
    >
      {item.label}
    </DropdownMenuItem>
  );
}

function RecentTabCountMenuItem({
  item,
  isSelected,
  onSelect,
}: {
  item: { value: SidebarEmbeddedRecentTabCount; label: string };
  isSelected: boolean;
  onSelect: (count: SidebarEmbeddedRecentTabCount) => void;
}) {
  const handleSelect = useCallback(() => onSelect(item.value), [item.value, onSelect]);
  return (
    <DropdownMenuItem
      testID={`sidebar-recent-tab-count-${item.value}`}
      selected={isSelected}
      onSelect={handleSelect}
    >
      {item.label}
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
}));
