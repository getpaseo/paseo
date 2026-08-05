import { useCallback, useMemo, type ComponentType, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  CircleCheck,
  CircleDashed,
  Clock,
  Diff,
  Folder,
  GitBranch,
  GitPullRequest,
  Server,
  Settings2,
  SquareTerminal,
  Type,
} from "lucide-react-native";
import {
  MenuItem,
  MenuRoot,
  MenuSeparator,
  MenuSubTrigger,
  MenuSurface,
  MenuTrigger,
  type MenuPageDefinition,
} from "@/components/ui/menu";
import { HostStatusDot } from "@/components/host-status-dot";
import { isWeb } from "@/constants/platform";
import { useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import type { SidebarGroupMode } from "@/stores/sidebar-view-store";
import type { WorkspaceTitleSource } from "@/hooks/use-settings";
import { useSidebarDisplayPreferences, type SidebarTrailingChoice } from "./model";
import { SIDEBAR_ROW_ITEMS, type SidebarRowItem } from "./row-items";

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ThemedSettings2 = withUnistyles(Settings2);

/** Fits the item's 16pt leading slot with a hair of room, matching the trailing check. */
const OPTION_ICON_SIZE = 14;
const MENU_WIDTH = 232;

type OptionIcon = ComponentType<{
  size: number;
  uniProps: (theme: Theme) => { color: string };
}>;

// Options carry icons; the root rows deliberately do not. The root is four labels with their
// current values, and a column of icons there would be decoration competing with the values.
const GROUPING_ICONS: Record<SidebarGroupMode, OptionIcon> = {
  project: withUnistyles(Folder),
  status: withUnistyles(CircleDashed),
};

const TITLE_SOURCE_ICONS: Record<WorkspaceTitleSource, OptionIcon> = {
  title: withUnistyles(Type),
  branch: withUnistyles(GitBranch),
};

// The same marks these things carry on the workspace row itself, so the menu and the row it
// configures name each item the same way twice.
const ROW_ITEM_ICONS: Record<SidebarRowItem, OptionIcon> = {
  host: withUnistyles(Server),
  changeRequest: withUnistyles(GitPullRequest),
  checks: withUnistyles(CircleCheck),
  scripts: withUnistyles(SquareTerminal),
};

const TRAILING_ICONS: Record<SidebarTrailingChoice, OptionIcon> = {
  diff: withUnistyles(Diff),
  timestamp: withUnistyles(Clock),
};

const GROUPING_MODES: readonly SidebarGroupMode[] = ["project", "status"];
const TITLE_SOURCES: readonly WorkspaceTitleSource[] = ["title", "branch"];
const TRAILING_CHOICES: readonly SidebarTrailingChoice[] = ["diff", "timestamp"];

const GROUPING_LABEL_KEYS: Record<SidebarGroupMode, string> = {
  project: "sidebar.display.grouping.project",
  status: "sidebar.display.grouping.status",
};

const TITLE_SOURCE_LABEL_KEYS: Record<WorkspaceTitleSource, string> = {
  title: "sidebar.display.titleSource.title",
  branch: "sidebar.display.titleSource.branch",
};

const ROW_ITEM_LABEL_KEYS: Record<SidebarRowItem, string> = {
  host: "sidebar.display.show.host",
  changeRequest: "sidebar.display.show.changeRequest",
  checks: "sidebar.display.show.checks",
  scripts: "sidebar.display.show.scripts",
};

const TRAILING_LABEL_KEYS: Record<SidebarTrailingChoice, string> = {
  diff: "sidebar.display.show.diff",
  timestamp: "sidebar.display.show.timestamp",
};

/**
 * What the sidebar shows and how it is arranged.
 *
 * The root is one row per decision with its current value; the options live a level down. The
 * shape is deliberate — every option of every decision on one surface is what this menu used to
 * be, and it grew a row for each host on top of that.
 */
export function SidebarDisplayPreferencesMenu(): ReactElement {
  const { t } = useTranslation();
  const preferences = useSidebarDisplayPreferences();
  const hosts = useHosts();

  const triggerStyle = useCallback(
    ({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.trigger,
      hovered && styles.triggerHovered,
    ],
    [],
  );

  const showHostFilter = hosts.length > 1;

  const pages = useMemo<MenuPageDefinition[]>(() => {
    const definitions: MenuPageDefinition[] = [
      {
        id: "grouping",
        title: t("sidebar.display.grouping.label"),
        content: (
          <OptionList
            values={GROUPING_MODES}
            icons={GROUPING_ICONS}
            labelKeys={GROUPING_LABEL_KEYS}
            selectedValue={preferences.grouping}
            onSelect={preferences.setGrouping}
            testIDPrefix="sidebar-grouping"
          />
        ),
      },
      {
        id: "titleSource",
        title: t("sidebar.display.titleSource.label"),
        content: (
          <OptionList
            values={TITLE_SOURCES}
            icons={TITLE_SOURCE_ICONS}
            labelKeys={TITLE_SOURCE_LABEL_KEYS}
            selectedValue={preferences.titleSource}
            onSelect={preferences.setTitleSource}
            testIDPrefix="sidebar-workspace-title-source"
          />
        ),
      },
      {
        id: "show",
        title: t("sidebar.display.show.label"),
        content: <ShowPage preferences={preferences} />,
      },
    ];

    if (showHostFilter) {
      definitions.push({
        id: "hostFilter",
        title: t("sidebar.display.hostFilter.label"),
        content: <HostFilterPage preferences={preferences} hosts={hosts} />,
      });
    }
    return definitions;
  }, [t, preferences, hosts, showHostFilter]);

  return (
    <MenuRoot compactMode="sheet">
      <MenuTrigger
        style={triggerStyle}
        accessibilityRole={isWeb ? undefined : "button"}
        accessibilityLabel={t("sidebar.display.trigger")}
        testID="sidebar-display-preferences-menu"
      >
        <ThemedSettings2 size={14} uniProps={mutedIconMapping} />
      </MenuTrigger>
      <MenuSurface
        align="end"
        width={MENU_WIDTH}
        pages={pages}
        sheetTitle={t("sidebar.display.heading")}
        testID="sidebar-display-preferences-content"
      >
        <MenuSubTrigger
          id="grouping"
          value={t(GROUPING_LABEL_KEYS[preferences.grouping])}
          testID="sidebar-display-grouping"
        >
          {t("sidebar.display.grouping.label")}
        </MenuSubTrigger>
        <MenuSubTrigger
          id="titleSource"
          value={t(TITLE_SOURCE_LABEL_KEYS[preferences.titleSource])}
          testID="sidebar-display-title-source"
        >
          {t("sidebar.display.titleSource.label")}
        </MenuSubTrigger>
        <MenuSubTrigger id="show" testID="sidebar-display-show">
          {t("sidebar.display.show.label")}
        </MenuSubTrigger>
        {showHostFilter ? (
          <>
            <MenuSeparator />
            {/* A filtered sidebar looks like workspaces went missing, so the branch says so
                from the root rather than making you open it to find out. */}
            <MenuSubTrigger
              id="hostFilter"
              indicator={preferences.hostFilters.length > 0}
              testID="sidebar-display-host-filter"
            >
              {t("sidebar.display.hostFilter.label")}
            </MenuSubTrigger>
          </>
        ) : null}
      </MenuSurface>
    </MenuRoot>
  );
}

type Preferences = ReturnType<typeof useSidebarDisplayPreferences>;

/** One option row: its mark on the left, its label, and a check when it is the chosen one. */
function OptionItem<Value extends string>({
  value,
  icon: Icon,
  label,
  selected,
  closeOnSelect = true,
  onSelect,
  testID,
}: {
  value: Value;
  icon: OptionIcon;
  label: string;
  selected: boolean;
  closeOnSelect?: boolean;
  onSelect: (value: Value) => void;
  testID: string;
}): ReactElement {
  const handleSelect = useCallback(() => onSelect(value), [onSelect, value]);
  const leading = useMemo(
    () => <Icon size={OPTION_ICON_SIZE} uniProps={mutedIconMapping} />,
    [Icon],
  );
  return (
    <MenuItem
      selected={selected}
      leading={leading}
      closeOnSelect={closeOnSelect}
      onSelect={handleSelect}
      testID={testID}
    >
      {label}
    </MenuItem>
  );
}

/** A page of mutually exclusive options — pick one and the menu closes. */
function OptionList<Value extends string>({
  values,
  icons,
  labelKeys,
  selectedValue,
  onSelect,
  testIDPrefix,
}: {
  values: readonly Value[];
  icons: Record<Value, OptionIcon>;
  labelKeys: Record<Value, string>;
  selectedValue: Value;
  onSelect: (value: Value) => void;
  testIDPrefix: string;
}): ReactNode {
  const { t } = useTranslation();
  return values.map((value) => (
    <OptionItem
      key={value}
      value={value}
      icon={icons[value]}
      label={t(labelKeys[value])}
      selected={value === selectedValue}
      onSelect={onSelect}
      testID={`${testIDPrefix}-${value}`}
    />
  ));
}

/**
 * Two groups, split by the separator. Above it, what a row may say about a workspace — each one
 * independent. Below it, the one thing the slot to the right of the title holds, so picking the
 * one already showing empties the slot and gives the width back to the title.
 */
function ShowPage({ preferences }: { preferences: Preferences }): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      {SIDEBAR_ROW_ITEMS.map((item) => (
        <OptionItem
          key={item}
          value={item}
          icon={ROW_ITEM_ICONS[item]}
          label={t(ROW_ITEM_LABEL_KEYS[item])}
          selected={preferences.rowItems[item]}
          closeOnSelect={false}
          onSelect={preferences.toggleRowItem}
          testID={`sidebar-row-item-${item}`}
        />
      ))}
      <MenuSeparator />
      {TRAILING_CHOICES.map((choice) => (
        <OptionItem
          key={choice}
          value={choice}
          icon={TRAILING_ICONS[choice]}
          label={t(TRAILING_LABEL_KEYS[choice])}
          selected={preferences.trailing === choice}
          closeOnSelect={false}
          onSelect={preferences.toggleTrailing}
          testID={`sidebar-workspace-trailing-${choice}`}
        />
      ))}
    </>
  );
}

function HostFilterPage({
  preferences,
  hosts,
}: {
  preferences: Preferences;
  hosts: ReturnType<typeof useHosts>;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      <MenuItem
        selected={preferences.hostFilters.length === 0}
        closeOnSelect={false}
        onSelect={preferences.clearHostFilters}
        testID="sidebar-host-filter-all"
      >
        {t("sidebar.display.hostFilter.all")}
      </MenuItem>
      {hosts.map((host) => (
        <HostFilterItem
          key={host.serverId}
          serverId={host.serverId}
          label={host.label?.trim() || host.serverId}
          selected={preferences.hostFilters.includes(host.serverId)}
          onToggle={preferences.toggleHostFilter}
        />
      ))}
    </>
  );
}

/** The one option row whose mark is live state rather than an icon. */
function HostFilterItem({
  serverId,
  label,
  selected,
  onToggle,
}: {
  serverId: string;
  label: string;
  selected: boolean;
  onToggle: (serverId: string) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onToggle(serverId), [onToggle, serverId]);
  const leading = useMemo(
    () => (
      <View testID={`sidebar-host-filter-status-${serverId}`}>
        <HostStatusDot serverId={serverId} />
      </View>
    ),
    [serverId],
  );

  return (
    <MenuItem
      selected={selected}
      closeOnSelect={false}
      leading={leading}
      onSelect={handleSelect}
      testID={`sidebar-host-filter-${serverId}`}
    >
      {label}
    </MenuItem>
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
}));
