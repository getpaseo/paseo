import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Bell,
  Blocks,
  Bot,
  Boxes,
  Code2,
  FolderGit2,
  Gauge,
  Globe2,
  Info,
  Keyboard,
  Layers,
  Link,
  Network,
  Palette,
  PanelsTopLeft,
  Plus,
  Puzzle,
  Server,
  Settings,
  Shield,
  Smartphone,
  Sparkles,
  SquareTerminal,
  Stethoscope,
  Zap,
  type LucideIcon,
} from "@/components/icons/ui-icons";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { SearchField } from "@/components/ui/search-field";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { HostPicker as SharedHostPicker } from "@/components/hosts/host-picker";
import { HostStatusDot } from "@/components/host-status-dot";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { WindowChromeSafeArea } from "@/utils/desktop-window";
import { SETTINGS_DESKTOP_SIDEBAR_WIDTH } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { isElectronRuntime } from "@/desktop/host";
import { useEnableBuiltInDaemonOption } from "@/desktop/hooks/use-enable-built-in-daemon-option";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useHosts } from "@/runtime/host-runtime";
import { orderHostsLocalFirst, type HostProfile } from "@/types/host-connection";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { SettingsView } from "@/navigation/settings-navigation";
import {
  SETTINGS_GROUPS,
  resolveSettingsPageIdForView,
  resolveVisibleSettingsPages,
  type SettingsGroupId,
  type SettingsPage,
  type SettingsPageId,
} from "@/screens/settings/settings-pages";
import {
  buildSettingsSearchDocuments,
  searchSettings,
  type SettingsSearchHit,
} from "@/screens/settings/settings-search";

export const SETTINGS_PAGE_ICONS: Record<SettingsPageId, LucideIcon> = {
  general: Settings,
  appearance: Palette,
  layout: PanelsTopLeft,
  editor: Code2,
  shortcuts: Keyboard,
  notifications: Bell,
  providers: Boxes,
  usage: Gauge,
  agents: Bot,
  "system-one": Zap,
  metadata: Sparkles,
  plugins: Blocks,
  projects: FolderGit2,
  workspaces: Layers,
  "linked-accounts": Link,
  host: Server,
  connections: Network,
  "pair-device": Smartphone,
  browser: Globe2,
  terminals: SquareTerminal,
  integrations: Puzzle,
  permissions: Shield,
  diagnostics: Stethoscope,
  about: Info,
};

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const inkColorMapping = (theme: Theme) => ({ color: theme.colors.surface0 });

function pageTestID(page: SettingsPage): string {
  return page.scope === "host" ? `settings-host-section-${page.id}` : `settings-section-${page.id}`;
}

interface NavRowProps {
  icon: LucideIcon;
  label: string;
  detail?: string | null;
  isSelected: boolean;
  onPress: () => void;
  testID: string;
}

function NavRow({ icon, label, detail = null, isSelected, onPress, testID }: NavRowProps) {
  const ThemedIcon = useMemo(() => withUnistyles(icon), [icon]);
  const accessibilityState = useMemo(() => ({ selected: isSelected }), [isSelected]);
  const rowStyle = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.item,
      Boolean(hovered) && !isSelected && styles.itemHovered,
      isSelected && styles.itemSelected,
    ],
    [isSelected],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={onPress}
      style={rowStyle}
      testID={testID}
    >
      <ThemedIcon size={ICON_SIZE.md} uniProps={isSelected ? inkColorMapping : mutedColorMapping} />
      <View style={styles.itemText}>
        <Text style={[styles.label, isSelected && styles.labelSelected]} numberOfLines={1}>
          {label}
        </Text>
        {detail ? (
          <Text style={[styles.detail, isSelected && styles.labelSelected]} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

interface PageRowProps {
  page: SettingsPage;
  label: string;
  detail?: string | null;
  isSelected: boolean;
  onSelectPage: (page: SettingsPage) => void;
  testID: string;
}

function PageRow({ page, label, detail, isSelected, onSelectPage, testID }: PageRowProps) {
  const handlePress = useCallback(() => onSelectPage(page), [onSelectPage, page]);
  return (
    <NavRow
      icon={SETTINGS_PAGE_ICONS[page.id]}
      label={label}
      detail={detail}
      isSelected={isSelected}
      onPress={handlePress}
      testID={testID}
    />
  );
}

interface HostPickerProps {
  activeServerId: string | null;
  sortedHosts: HostProfile[];
  onSelectHost: (serverId: string) => void;
  onAddHost: () => void;
}

/**
 * Scopes every host page, whichever group it sits in. A quiet row-styled
 * trigger opening the shared host <Combobox>; "Add host" is always reachable.
 */
function HostPicker({ activeServerId, sortedHosts, onSelectHost, onAddHost }: HostPickerProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<View | null>(null);
  const enableBuiltInDaemonOption = useEnableBuiltInDaemonOption();
  const activeHost =
    sortedHosts.find((host) => host.serverId === activeServerId) ?? sortedHosts[0] ?? null;
  const handleOpen = useCallback(() => setIsOpen(true), []);
  const hostOptionTestID = useCallback(
    (serverId: string) => `settings-host-picker-item-${serverId}`,
    [],
  );
  const triggerStyle = useCallback(
    ({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.pickerTrigger,
      hovered && styles.itemHovered,
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
          <View style={styles.pickerTriggerDot}>
            <HostStatusDot serverId={activeHost.serverId} />
          </View>
        ) : null}
        <Text style={styles.pickerTriggerLabel} numberOfLines={1}>
          {activeHost?.label ?? t("settings.groups.host")}
        </Text>
      </ComboboxTrigger>
    </SharedHostPicker>
  );
}

function AddHostRows({ onAddHost }: { onAddHost: () => void }) {
  const { t } = useTranslation();
  const enableBuiltInDaemonOption = useEnableBuiltInDaemonOption();
  return (
    <>
      <NavRow
        icon={Plus}
        label={t("settings.addHost")}
        isSelected={false}
        onPress={onAddHost}
        testID="settings-add-host"
      />
      {enableBuiltInDaemonOption.visible ? (
        <NavRow
          icon={Server}
          label={t("settings.enableBuiltInDaemon")}
          isSelected={false}
          onPress={enableBuiltInDaemonOption.onPress}
          testID="settings-enable-built-in-daemon"
        />
      ) : null}
    </>
  );
}

interface SearchResultsProps {
  hits: SettingsSearchHit[];
  pagesById: Map<SettingsPageId, SettingsPage>;
  selectedPageId: SettingsPageId | null;
  onSelectPage: (page: SettingsPage) => void;
}

function SearchResults({ hits, pagesById, selectedPageId, onSelectPage }: SearchResultsProps) {
  const { t } = useTranslation();
  if (hits.length === 0) {
    return (
      <Text style={styles.searchEmpty} testID="settings-search-empty">
        {t("settings.search.empty")}
      </Text>
    );
  }
  return (
    <View style={styles.group} testID="settings-search-results">
      {hits.map((hit) => {
        const page = pagesById.get(hit.pageId);
        if (!page) return null;
        return (
          <PageRow
            key={hit.pageId}
            page={page}
            label={hit.title}
            detail={hit.detail}
            isSelected={selectedPageId === hit.pageId}
            onSelectPage={onSelectPage}
            testID={`settings-search-result-${hit.pageId}`}
          />
        );
      })}
    </View>
  );
}

export interface SettingsNavProps {
  view: SettingsView;
  activeHostServerId: string | null;
  onSelectPage: (page: SettingsPage) => void;
  onSelectHost: (serverId: string) => void;
  onAddHost: () => void;
  onBackToWorkspace: () => void;
  layout: "desktop" | "mobile";
}

/**
 * Settings navigation: search over every page, then the four groups. Host
 * pages sit in whichever group they belong to and all follow the host picker.
 */
export function SettingsNav({
  view,
  activeHostServerId,
  onSelectPage,
  onSelectHost,
  onAddHost,
  onBackToWorkspace,
  layout,
}: SettingsNavProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const sortedHosts = useMemo(
    () => orderHostsLocalFirst(hosts, localServerId),
    [hosts, localServerId],
  );
  const hasHost = sortedHosts.length > 0;
  const isDesktopApp = isElectronRuntime();
  const [query, setQuery] = useState("");
  // SearchField owns its text, so a jump from the results remounts it empty.
  const [searchFieldKey, setSearchFieldKey] = useState(0);
  const selectSearchHit = useCallback(
    (page: SettingsPage) => {
      setQuery("");
      setSearchFieldKey((key) => key + 1);
      onSelectPage(page);
    },
    [onSelectPage],
  );

  const pages = useMemo(
    () => resolveVisibleSettingsPages({ isDesktopApp, isWeb, hasHost }),
    [hasHost, isDesktopApp],
  );
  const pagesById = useMemo(() => new Map(pages.map((page) => [page.id, page])), [pages]);
  const pagesByGroup = useMemo(() => {
    const grouped = new Map<SettingsGroupId, SettingsPage[]>();
    for (const page of pages) {
      grouped.set(page.group, [...(grouped.get(page.group) ?? []), page]);
    }
    return grouped;
  }, [pages]);
  const searchDocuments = useMemo(() => buildSettingsSearchDocuments(pages, t), [pages, t]);
  const hits = useMemo(() => searchSettings(searchDocuments, query), [query, searchDocuments]);
  const selectedPageId = resolveSettingsPageIdForView(view);
  const isSearching = query.trim().length > 0;

  const groups = SETTINGS_GROUPS.map((group) => {
    const groupPages = pagesByGroup.get(group.id) ?? [];
    const showAddHost = group.id === "host" && !hasHost;
    if (groupPages.length === 0 && !showAddHost) return null;
    return (
      <View key={group.id} style={styles.group} testID={`settings-group-${group.id}`}>
        <Text style={styles.groupLabel}>{t(group.labelKey)}</Text>
        {showAddHost ? <AddHostRows onAddHost={onAddHost} /> : null}
        {groupPages.map((page) => (
          <PageRow
            key={page.id}
            page={page}
            label={t(page.labelKey)}
            isSelected={selectedPageId === page.id}
            onSelectPage={onSelectPage}
            testID={pageTestID(page)}
          />
        ))}
      </View>
    );
  });

  const body = (
    <>
      <View style={styles.searchRow}>
        <SearchField
          key={searchFieldKey}
          value={query}
          onChangeText={setQuery}
          placeholder={t("settings.search.placeholder")}
          clearAccessibilityLabel={t("settings.search.clear")}
          testID="settings-search-input"
          clearTestID="settings-search-clear"
        />
      </View>
      {isSearching ? (
        <SearchResults
          hits={hits}
          pagesById={pagesById}
          selectedPageId={selectedPageId}
          onSelectPage={selectSearchHit}
        />
      ) : (
        <>
          {hasHost ? (
            <View style={styles.pickerRow}>
              <HostPicker
                activeServerId={activeHostServerId}
                sortedHosts={sortedHosts}
                onSelectHost={onSelectHost}
                onAddHost={onAddHost}
              />
            </View>
          ) : null}
          {groups}
        </>
      )}
    </>
  );

  if (layout === "mobile") {
    return (
      <View
        accessibilityLabel={t("settings.title")}
        role="navigation"
        style={styles.mobileContainer}
        testID="settings-sidebar"
      >
        {body}
      </View>
    );
  }

  return (
    <View
      accessibilityLabel={t("settings.title")}
      role="navigation"
      style={styles.desktopContainer}
      testID="settings-sidebar"
    >
      <View style={[styles.desktopInner, { paddingTop: insets.top }]}>
        <View style={styles.dragArea}>
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
          style={styles.scrollBody}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          testID="settings-sidebar-scroll-body"
        >
          {body}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  desktopContainer: {
    width: SETTINGS_DESKTOP_SIDEBAR_WIDTH,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  desktopInner: {
    flex: 1,
  },
  dragArea: {
    position: "relative",
  },
  scrollBody: {
    flex: 1,
  },
  mobileContainer: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  searchRow: {
    flexDirection: "row",
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  pickerRow: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
  },
  group: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[4],
    gap: theme.spacing[0.5],
  },
  // Small tracked capitals: the group names a region, it is not a row to act on.
  groupLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 32,
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.base,
  },
  itemHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  // The current page is filled with ink, whatever accent the user picked.
  itemSelected: {
    backgroundColor: theme.colors.foreground,
  },
  itemText: {
    flex: 1,
    minWidth: 0,
  },
  label: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.normal,
  },
  labelSelected: {
    color: theme.colors.surface0,
  },
  detail: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  searchEmpty: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
  },
  pickerTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 32,
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.base,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  pickerTriggerLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.normal,
  },
  // Match the page icons' footprint so the host label sits on the same rail.
  pickerTriggerDot: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
  },
}));
