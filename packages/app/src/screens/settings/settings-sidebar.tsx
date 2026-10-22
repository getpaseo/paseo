import { useCallback, useMemo, useRef, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Plus, Server } from "lucide-react-native";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { HostPicker as SharedHostPicker } from "@/components/hosts/host-picker";
import { HostStatusDot } from "@/components/host-status-dot";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { WindowChromeSafeArea } from "@/utils/desktop-window";
import { useHosts } from "@/runtime/host-runtime";
import { orderHostsLocalFirst, type HostProfile } from "@/types/host-connection";
import { isElectronRuntime } from "@/desktop/host";
import { SETTINGS_DESKTOP_SIDEBAR_WIDTH } from "@/constants/layout";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import {
  type EnableBuiltInDaemonOption,
  useEnableBuiltInDaemonOption,
} from "@/desktop/hooks/use-enable-built-in-daemon-option";
import {
  HOST_SECTION_ITEMS,
  SIDEBAR_SECTION_ITEMS,
  isSectionAvailable,
} from "@/screens/settings/sections";
import { densityIconBox, densityIconProps } from "@/styles/density";
import type { Theme } from "@/styles/theme";
import type { HostSectionSlug, SettingsSectionSlug } from "@/utils/host-routes";
import type { SettingsView } from "@/navigation/settings-navigation";

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const selectedIconProps = densityIconProps("md", foregroundColorMapping);
const mutedIconProps = densityIconProps("md", foregroundMutedColorMapping);
const ThemedPlus = withUnistyles(Plus);
const ThemedServer = withUnistyles(Server);

function sidebarItemStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    sidebarStyles.item,
    Boolean(hovered) && sidebarStyles.itemHovered,
    pressed && sidebarStyles.itemPressed,
  ];
}

function selectedSidebarItemStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    sidebarStyles.item,
    Boolean(hovered) && sidebarStyles.itemHovered,
    sidebarStyles.itemSelected,
    pressed && sidebarStyles.itemPressed,
  ];
}

/**
 * Local daemon first, then remaining hosts in their existing order.
 */
export function useSortedHosts(hosts: HostProfile[], localServerId: string | null): HostProfile[] {
  return useMemo(() => orderHostsLocalFirst(hosts, localServerId), [hosts, localServerId]);
}

// Lighter than lucide's default 2px stroke so the nav reads quieter than the content.
const SIDEBAR_ICON_STROKE_WIDTH = 1.5;

type SidebarIcon = ComponentType<{ size: number; color: string; strokeWidth?: number }>;

function createThemedSidebarIcon(Icon: SidebarIcon) {
  return withUnistyles(Icon);
}

const themedSidebarIcons = new Map<SidebarIcon, ReturnType<typeof createThemedSidebarIcon>>();

function getThemedSidebarIcon(Icon: SidebarIcon) {
  const cached = themedSidebarIcons.get(Icon);
  if (cached) return cached;
  const themed = createThemedSidebarIcon(Icon);
  themedSidebarIcons.set(Icon, themed);
  return themed;
}

interface SidebarNavButtonProps<Id extends string> {
  itemId: Id;
  label: string;
  icon: SidebarIcon;
  isSelected: boolean;
  onSelect: (id: Id) => void;
  testID?: string;
}

function SidebarNavButton<Id extends string>({
  itemId,
  label,
  icon: IconComponent,
  isSelected,
  onSelect,
  testID,
}: SidebarNavButtonProps<Id>) {
  const ThemedIcon = getThemedSidebarIcon(IconComponent);
  const handlePress = useCallback(() => {
    onSelect(itemId);
  }, [onSelect, itemId]);
  const accessibilityState = useMemo(() => ({ selected: isSelected }), [isSelected]);
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={handlePress}
      testID={testID}
      style={isSelected ? selectedSidebarItemStyle : sidebarItemStyle}
    >
      <ThemedIcon
        strokeWidth={SIDEBAR_ICON_STROKE_WIDTH}
        uniProps={isSelected ? selectedIconProps : mutedIconProps}
      />
      <Text
        style={[sidebarStyles.label, isSelected && sidebarStyles.labelSelected]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </PressHighlight>
  );
}

interface HostPickerProps {
  activeServerId: string | null;
  sortedHosts: HostProfile[];
  onSelectHost: (serverId: string) => void;
  onAddHost: () => void;
  enableBuiltInDaemonOption: EnableBuiltInDaemonOption;
}

/**
 * Scopes the host sections to a host. Reuses the canonical sidebar host
 * switcher pattern (left-sidebar.tsx): a quiet row-styled trigger opening a
 * <Combobox>. The local host is listed first, each row shows the connection it
 * is using right now; an "Add host" row is always reachable from the list —
 * even with a single host.
 */
function HostPicker({
  activeServerId,
  sortedHosts,
  onSelectHost,
  onAddHost,
  enableBuiltInDaemonOption,
}: HostPickerProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<View | null>(null);
  const activeHost =
    sortedHosts.find((host) => host.serverId === activeServerId) ?? sortedHosts[0] ?? null;

  const handleOpen = useCallback(() => setIsOpen(true), []);
  const hostOptionTestID = useCallback(
    (serverId: string) => `settings-host-picker-item-${serverId}`,
    [],
  );
  const triggerStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      sidebarStyles.pickerTrigger,
      hovered && sidebarStyles.pickerTriggerHovered,
      pressed && sidebarStyles.itemPressed,
    ],
    [],
  );

  return (
    <SharedHostPicker
      hosts={sortedHosts}
      value={activeServerId ?? ""}
      onSelect={onSelectHost}
      open={isOpen}
      onOpenChange={setIsOpen}
      anchorRef={triggerRef}
      includeAddHost
      onAddHost={onAddHost}
      includeEnableBuiltInDaemon={enableBuiltInDaemonOption.visible}
      onEnableBuiltInDaemon={enableBuiltInDaemonOption.onPress}
      showActiveConnection
      searchable={false}
      title={t("settings.hostPicker.switchHost")}
      desktopMinWidth={240}
      addHostTestID="settings-add-host"
      hostOptionTestID={hostOptionTestID}
    >
      <ComboboxTrigger
        ref={triggerRef}
        block
        style={triggerStyle}
        onPress={handleOpen}
        accessibilityRole="button"
        accessibilityLabel={t("settings.hostPicker.switchHost")}
        testID="settings-host-picker"
      >
        {activeHost ? (
          <View style={sidebarStyles.pickerTriggerDot}>
            <HostStatusDot serverId={activeHost.serverId} />
          </View>
        ) : null}
        <Text style={sidebarStyles.pickerTriggerLabel} numberOfLines={1}>
          {activeHost?.label ?? t("settings.groups.host")}
        </Text>
      </ComboboxTrigger>
    </SharedHostPicker>
  );
}

/** A labelled group of sidebar rows. On compact layouts the rows sit together in one island. */
function SidebarGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <View style={sidebarStyles.group}>
      {label ? <Text style={sidebarStyles.groupLabel}>{label}</Text> : null}
      <View style={sidebarStyles.island}>{children}</View>
    </View>
  );
}

interface SettingsSidebarProps {
  view: SettingsView;
  onSelectSection: (section: SettingsSectionSlug) => void;
  onSelectHostSection: (section: HostSectionSlug) => void;
  onSelectHost: (serverId: string) => void;
  onAddHost: () => void;
  onBackToWorkspace: () => void;
  activeHostServerId: string | null;
  layout: "desktop" | "mobile";
}

export function SettingsSidebar({
  view,
  onSelectSection,
  onSelectHostSection,
  onSelectHost,
  onAddHost,
  onBackToWorkspace,
  activeHostServerId,
  layout,
}: SettingsSidebarProps) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const sortedHosts = useSortedHosts(hosts, localServerId);
  const hasHosts = sortedHosts.length > 0;
  const enableBuiltInDaemonOption = useEnableBuiltInDaemonOption();
  const isDesktopApp = isElectronRuntime();
  const items = SIDEBAR_SECTION_ITEMS.filter((item) => isSectionAvailable(item, isDesktopApp));
  const insets = useSafeAreaInsets();
  const isDesktop = layout === "desktop";
  const outerContainerStyle = useMemo(
    () => [isDesktop ? sidebarStyles.desktopContainer : sidebarStyles.mobileContainer],
    [isDesktop],
  );
  const innerContainerStyle = useMemo(
    () => [{ flex: 1 }, isDesktop ? { paddingTop: insets.top } : null],
    [insets.top, isDesktop],
  );
  const selectedSectionId = view.kind === "section" ? view.section : null;
  let selectedHostSection: HostSectionSlug | null = null;
  if (view.kind === "host") selectedHostSection = view.section;
  if (view.kind === "project") selectedHostSection = "projects";
  if (view.kind === "plugin") selectedHostSection = "plugins";

  const sidebarBody = (
    <>
      <SidebarGroup label={t("settings.groups.app")}>
        {items.map((item) => (
          <SidebarNavButton
            key={item.id}
            itemId={item.id}
            label={t(item.labelKey)}
            icon={item.icon}
            isSelected={selectedSectionId === item.id}
            onSelect={onSelectSection}
          />
        ))}
      </SidebarGroup>
      {hasHosts ? (
        <SidebarGroup label={t("settings.groups.host")}>
          <HostPicker
            activeServerId={activeHostServerId}
            sortedHosts={sortedHosts}
            onSelectHost={onSelectHost}
            onAddHost={onAddHost}
            enableBuiltInDaemonOption={enableBuiltInDaemonOption}
          />
          {HOST_SECTION_ITEMS.map((item) => (
            <SidebarNavButton
              key={item.id}
              itemId={item.id}
              label={t(item.labelKey)}
              icon={item.icon}
              testID={`settings-host-section-${item.id}`}
              isSelected={selectedHostSection === item.id}
              onSelect={onSelectHostSection}
            />
          ))}
        </SidebarGroup>
      ) : (
        <SidebarGroup>
          <PressHighlight
            accessibilityRole="button"
            accessibilityLabel={t("settings.addHost")}
            onPress={onAddHost}
            testID="settings-add-host"
            style={sidebarItemStyle}
          >
            <ThemedPlus strokeWidth={SIDEBAR_ICON_STROKE_WIDTH} uniProps={mutedIconProps} />
            <Text style={sidebarStyles.label} numberOfLines={1}>
              {t("settings.addHost")}
            </Text>
          </PressHighlight>
          {enableBuiltInDaemonOption.visible ? (
            <PressHighlight
              accessibilityRole="button"
              accessibilityLabel={t("settings.enableBuiltInDaemon")}
              onPress={enableBuiltInDaemonOption.onPress}
              testID="settings-enable-built-in-daemon"
              style={sidebarItemStyle}
            >
              <ThemedServer strokeWidth={SIDEBAR_ICON_STROKE_WIDTH} uniProps={mutedIconProps} />
              <Text style={sidebarStyles.label} numberOfLines={1}>
                {t("settings.enableBuiltInDaemon")}
              </Text>
            </PressHighlight>
          ) : null}
        </SidebarGroup>
      )}
    </>
  );

  return (
    <View
      accessibilityLabel={t("settings.title")}
      role="navigation"
      style={outerContainerStyle}
      testID="settings-sidebar"
    >
      {isDesktop ? (
        <View style={innerContainerStyle}>
          <View style={sidebarStyles.sidebarDragArea}>
            <TitlebarDragRegion />
            <WindowChromeSafeArea placement="below" />
            <SidebarHeaderRow
              icon={ArrowLeft}
              label={t("settings.backToWorkspace")}
              onPress={onBackToWorkspace}
              testID="settings-back-to-workspace"
            />
          </View>
          <ScrollView
            style={sidebarStyles.scrollBody}
            showsVerticalScrollIndicator={false}
            testID="settings-sidebar-scroll-body"
          >
            {sidebarBody}
          </ScrollView>
        </View>
      ) : (
        sidebarBody
      )}
    </View>
  );
}

const sidebarStyles = StyleSheet.create((theme) => ({
  desktopContainer: {
    width: SETTINGS_DESKTOP_SIDEBAR_WIDTH,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  scrollBody: {
    flex: 1,
  },
  sidebarDragArea: {
    position: "relative",
  },
  mobileContainer: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  // Compact values draw each group as an island of tiles; desktop keeps a plain list.
  group: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    gap: { xs: theme.spacing[1], md: theme.spacing[0.5] },
  },
  groupLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundExtraMuted,
    paddingHorizontal: { xs: theme.spacing[4], md: theme.spacing[2] },
    paddingVertical: theme.spacing[1],
  },
  island: {
    gap: { xs: 2, md: theme.spacing[0.5] },
    borderRadius: { xs: theme.borderRadius["2xl"], md: 0 },
    overflow: "hidden",
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: { xs: theme.spacing[3], md: theme.spacing[2] },
    minHeight: { xs: 52, md: 28 },
    paddingVertical: theme.spacing[1],
    paddingHorizontal: { xs: theme.spacing[4], md: theme.spacing[2] },
    borderRadius: { xs: 0, md: theme.borderRadius.lg },
    backgroundColor: { xs: theme.colors.surface1, md: "transparent" },
  },
  itemHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  itemSelected: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  // The workspace rows' pressed fill.
  itemPressed: {
    backgroundColor: theme.colors.surface2,
  },
  label: {
    fontSize: { xs: theme.fontSize.lg, md: theme.fontSize.base },
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.normal,
    flex: 1,
  },
  labelSelected: {
    color: theme.colors.foreground,
  },
  pickerTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: { xs: theme.spacing[3], md: theme.spacing[2] },
    minHeight: { xs: 52, md: 28 },
    paddingVertical: theme.spacing[1],
    paddingHorizontal: { xs: theme.spacing[4], md: theme.spacing[2] },
    borderRadius: { xs: 0, md: theme.borderRadius.lg },
    backgroundColor: { xs: theme.colors.surface1, md: "transparent" },
  },
  pickerTriggerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  pickerTriggerLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: { xs: theme.fontSize.lg, md: theme.fontSize.base },
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.normal,
  },
  // Match the setting items' icon footprint so the host label aligns with them.
  pickerTriggerDot: {
    width: densityIconBox("md"),
    height: densityIconBox("md"),
    alignItems: "center",
    justifyContent: "center",
  },
}));
