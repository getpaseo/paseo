import { useCallback, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ArrowDown,
  ArrowUp,
  Blocks,
  CalendarClock,
  Gauge,
  History,
  Plus,
  Search,
  type LucideIcon,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { Shortcut } from "@/components/ui/shortcut";
import { Switch } from "@/components/ui/switch";
import { useAppSettings, type SidebarHeaderLayout } from "@/hooks/use-settings";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import {
  builtinSidebarNavLabelKey,
  builtinSidebarNavShortcutAction,
  type BuiltinSidebarItemId,
  type SidebarNavItem,
  type SidebarSection,
} from "@/sidebar-nav/model";
import { resolvePluginIcon } from "@/plugins/icons";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);

const moveUpIcon = <ThemedArrowUp size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const moveDownIcon = <ThemedArrowDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;

const BUILTIN_ICONS: Record<BuiltinSidebarItemId, LucideIcon> = {
  "new-workspace": Plus,
  history: History,
  search: Search,
  schedules: CalendarClock,
  usage: Gauge,
};

/** Plugin items register no icon, so they share this one; a legacy `addSidebarItem` keeps its own. */
const PLUGIN_ICON = Blocks;

function NavIcon({ Icon, color = "" }: { Icon: LucideIcon; color?: string }) {
  return <Icon size={ICON_SIZE.md} color={color} />;
}

const ThemedNavIcon = withUnistyles(NavIcon);

function navItemIcon(item: SidebarNavItem): LucideIcon {
  if (item.kind === "builtin") return BUILTIN_ICONS[item.id];
  return item.group.kind === "legacy" ? resolvePluginIcon(item.group.icon) : PLUGIN_ICON;
}

function navItemLabel(t: TFunction, item: SidebarNavItem): string {
  return item.kind === "builtin" ? t(builtinSidebarNavLabelKey(item.id)) : item.group.title;
}

/** Own component so the row can stay hook-free about which items have a shortcut. */
function NavItemShortcut({ item }: { item: SidebarNavItem }): ReactElement | null {
  const chord = useShortcutKeys(
    item.kind === "builtin" ? builtinSidebarNavShortcutAction(item.id) : null,
  );
  return chord ? <Shortcut chord={chord} /> : null;
}

interface SidebarNavRowProps {
  item: SidebarNavItem;
  isFirst: boolean;
  /** The divider follows the card's rows, which can include rows that are not items. */
  hasRowAbove: boolean;
  isLast: boolean;
  onMove: (key: string, direction: "up" | "down") => void;
  onSetVisible: (key: string, visible: boolean) => void;
}

function SidebarNavRow({
  item,
  isFirst,
  hasRowAbove,
  isLast,
  onMove,
  onSetVisible,
}: SidebarNavRowProps): ReactElement {
  const { t } = useTranslation();
  const label = navItemLabel(t, item);

  const handleMoveUp = useCallback(() => onMove(item.key, "up"), [item.key, onMove]);
  const handleMoveDown = useCallback(() => onMove(item.key, "down"), [item.key, onMove]);
  const handleVisibleChange = useCallback(
    (visible: boolean) => onSetVisible(item.key, visible),
    [item.key, onSetVisible],
  );

  const rowStyle = useMemo(
    () => [settingsStyles.row, hasRowAbove ? settingsStyles.rowBorder : null, styles.row],
    [hasRowAbove],
  );

  return (
    <View style={rowStyle} testID={`sidebar-nav-item-${item.key}`}>
      <View style={styles.rowMain}>
        <ThemedNavIcon Icon={navItemIcon(item)} uniProps={mutedColorMapping} />
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {label}
        </Text>
        <NavItemShortcut item={item} />
      </View>
      <View style={styles.rowActions}>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={moveUpIcon}
          onPress={handleMoveUp}
          disabled={isFirst}
          accessibilityLabel={t("settings.appearance.sidebar.moveUp")}
          testID={`sidebar-nav-move-up-${item.key}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={moveDownIcon}
          onPress={handleMoveDown}
          disabled={isLast}
          accessibilityLabel={t("settings.appearance.sidebar.moveDown")}
          testID={`sidebar-nav-move-down-${item.key}`}
        />
        <Switch
          value={item.visible}
          onValueChange={handleVisibleChange}
          accessibilityLabel={label}
          testID={`sidebar-nav-toggle-${item.key}`}
        />
      </View>
    </View>
  );
}

const SECTION_COPY = {
  header: {
    title: "settings.appearance.sidebar.header.title",
    info: "settings.appearance.sidebar.header.description",
  },
  footer: {
    title: "settings.appearance.sidebar.footer.title",
    info: "settings.appearance.sidebar.footer.description",
  },
} as const satisfies Record<SidebarSection, { title: string; info: string }>;

function HeaderLayoutRow(): ReactElement {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const options = useMemo<SegmentedControlOption<SidebarHeaderLayout>[]>(
    () => [
      {
        value: "list",
        label: t("settings.appearance.sidebar.header.layout.list"),
        testID: "sidebar-header-layout-list",
      },
      {
        value: "compact",
        label: t("settings.appearance.sidebar.header.layout.compact"),
        testID: "sidebar-header-layout-compact",
      },
    ],
    [t],
  );
  const handleChange = useCallback(
    (layout: SidebarHeaderLayout) => {
      void updateSettings({ sidebarHeaderLayout: layout });
    },
    [updateSettings],
  );

  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>
          {t("settings.appearance.sidebar.header.layout.title")}
        </Text>
        <Text style={settingsStyles.rowHint}>
          {t("settings.appearance.sidebar.header.layout.hint")}
        </Text>
      </View>
      <SegmentedControl
        options={options}
        value={settings.sidebarHeaderLayout}
        onValueChange={handleChange}
        size="sm"
        testID="sidebar-header-layout"
      />
    </View>
  );
}

function SidebarItemsCard({ section }: { section: SidebarSection }): ReactElement {
  const { t } = useTranslation();
  const { items, setVisible, move } = useSidebarNavItems(section);
  const hasLayoutRow = section === "header";

  return (
    <SettingsSection
      title={t(SECTION_COPY[section].title)}
      info={t(SECTION_COPY[section].info)}
      testID={`sidebar-nav-section-${section}`}
    >
      <View style={settingsStyles.card}>
        {hasLayoutRow ? <HeaderLayoutRow /> : null}
        {items.map((item, index) => (
          <SidebarNavRow
            key={item.key}
            item={item}
            isFirst={index === 0}
            hasRowAbove={hasLayoutRow || index > 0}
            isLast={index === items.length - 1}
            onMove={move}
            onSetVisible={setVisible}
          />
        ))}
      </View>
    </SettingsSection>
  );
}

/** Settings > Sidebar: one card per section. The footer's bottom line is fixed and not listed. */
export function SidebarNavSection(): ReactElement {
  return (
    <>
      <SidebarItemsCard section="header" />
      <SidebarItemsCard section="footer" />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    gap: theme.spacing[2],
  },
  rowMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
