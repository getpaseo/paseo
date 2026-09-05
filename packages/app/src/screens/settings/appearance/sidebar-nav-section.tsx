import { useCallback, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ArrowDown,
  ArrowUp,
  CalendarClock,
  History,
  Plus,
  Search,
  type LucideIcon,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Shortcut } from "@/components/ui/shortcut";
import { Switch } from "@/components/ui/switch";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { resolvePluginIcon } from "@/plugins/icons";
import { SettingsSection } from "@/screens/settings/settings-section";
import {
  builtinSidebarNavLabelKey,
  builtinSidebarNavShortcutAction,
  type BuiltinSidebarNavId,
  type SidebarNavItem,
} from "@/sidebar-nav/model";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);

const moveUpIcon = <ThemedArrowUp size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const moveDownIcon = <ThemedArrowDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;

const BUILTIN_ICONS: Record<BuiltinSidebarNavId, LucideIcon> = {
  "new-workspace": Plus,
  history: History,
  search: Search,
  schedules: CalendarClock,
};

function NavIcon({ Icon, color = "" }: { Icon: LucideIcon; color?: string }) {
  return <Icon size={ICON_SIZE.md} color={color} />;
}

const ThemedNavIcon = withUnistyles(NavIcon);

function navItemIcon(item: SidebarNavItem): LucideIcon {
  return item.kind === "builtin" ? BUILTIN_ICONS[item.id] : resolvePluginIcon(item.group.icon);
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
  isLast: boolean;
  onMove: (key: string, direction: "up" | "down") => void;
  onSetVisible: (key: string, visible: boolean) => void;
}

function SidebarNavRow({
  item,
  isFirst,
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
    () => [settingsStyles.row, isFirst ? null : settingsStyles.rowBorder, styles.row],
    [isFirst],
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

export function SidebarNavSection(): ReactElement {
  const { t } = useTranslation();
  const { items, setVisible, move } = useSidebarNavItems();

  return (
    <SettingsSection
      title={t("settings.appearance.sidebar.title")}
      info={t("settings.appearance.sidebar.description")}
      testID="sidebar-nav-section"
    >
      <View style={settingsStyles.card}>
        {items.map((item, index) => (
          <SidebarNavRow
            key={item.key}
            item={item}
            isFirst={index === 0}
            isLast={index === items.length - 1}
            onMove={move}
            onSetVisible={setVisible}
          />
        ))}
      </View>
    </SettingsSection>
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
