import { router } from "expo-router";
import { Gauge } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { SidebarPopoverRoot, SidebarPopoverSurface } from "@/components/sidebar/sidebar-popover";
import { useIsCompactFormFactor } from "@/constants/layout";
import { builtinSidebarNavLabelKey } from "@/sidebar-nav/model";
import { usePanelStore } from "@/stores/panel-store";
import { buildUsageRoute } from "@/utils/host-routes";
import { useHostUsageWithControls } from "./controls";
import { useUsagePreferences, type UsageDisplay } from "./display";
import { useUsageHostId, useUsageHostSelection } from "./hosts";
import type { UsagePreferences } from "./preferences";
import { useHostUsage } from "./queries";
import { UsageSourceIcon } from "./source-icon";
import { resolvePinnedUsage, type PinnedUsageWindow } from "./pinned";
import type { UsageReportEntry } from "./types";
import type { UsageHost } from "./model";
import { UsageBody } from "./usage-section";

const NO_REPORTS: UsageReportEntry[] = [];
const NO_ITEMS: PinnedUsageWindow[] = [];

/**
 * The sidebar footer's usage entry: each pinned window's source icon and percent, or a plain
 * "Usage" row while no pinned window has data. Pressing it opens the Usage screen; on compact
 * layouts it opens the usage sheet instead.
 */
export function UsageSidebarItem() {
  const { preferences, display } = useUsagePreferences();
  const serverId = useUsageHostId();
  // Without pins there is nothing to summarize, so the host is not asked for reports.
  if (!serverId || preferences.pinned.length === 0) {
    return <UsageEntry serverId={serverId} items={NO_ITEMS} display={display} />;
  }
  return (
    <PinnedUsageItem
      key={serverId}
      serverId={serverId}
      preferences={preferences}
      display={display}
    />
  );
}

function PinnedUsageItem({
  serverId,
  preferences,
  display,
}: {
  serverId: string;
  preferences: UsagePreferences;
  display: UsageDisplay;
}) {
  const { view } = useHostUsage(serverId);
  const reports = view.kind === "ready" ? view.reports : NO_REPORTS;
  const items = useMemo(() => resolvePinnedUsage(reports, preferences), [preferences, reports]);
  return <UsageEntry serverId={serverId} items={items} display={display} />;
}

function useOpenUsageScreen(): () => void {
  const isCompact = useIsCompactFormFactor();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  return useCallback(() => {
    if (isCompact) showMobileAgent();
    router.push(buildUsageRoute());
  }, [isCompact, showMobileAgent]);
}

function UsageEntry({
  serverId,
  items,
  display,
}: {
  serverId: string | null;
  items: readonly PinnedUsageWindow[];
  display: UsageDisplay;
}) {
  const { t } = useTranslation();
  const label = t(builtinSidebarNavLabelKey("usage"));
  const isCompact = useIsCompactFormFactor();
  const openUsageScreen = useOpenUsageScreen();
  const [open, setOpen] = useState(false);
  // The sheet mounts on first open, so an unopened sidebar never asks the host for reports.
  const [sheetMounted, setSheetMounted] = useState(false);
  // Without a host there are no reports to show, so compact goes to the screen, which says so.
  const usesSheet = isCompact && serverId !== null;
  const handlePress = useCallback(() => {
    if (!usesSheet) {
      openUsageScreen();
      return;
    }
    setSheetMounted(true);
    setOpen(true);
  }, [openUsageScreen, usesSheet]);

  const trigger =
    items.length > 0 ? (
      <PinnedUsageTrigger label={label} items={items} onPress={handlePress} />
    ) : (
      <SidebarHeaderRow
        variant="inline"
        icon={Gauge}
        label={label}
        onPress={handlePress}
        testID="sidebar-usage"
      />
    );
  if (!usesSheet) return trigger;
  return (
    <SidebarPopoverRoot open={open} onOpenChange={setOpen}>
      {trigger}
      {sheetMounted ? <UsageSheet title={label} display={display} /> : null}
    </SidebarPopoverRoot>
  );
}

/**
 * The compact usage sheet: the Usage screen's host, reports with pins, and controls, the controls
 * in its title row.
 */
function UsageSheet({ title, display }: { title: string; display: UsageDisplay }) {
  const { serverId, connectedHosts, select } = useUsageHostSelection();
  if (!serverId) return null;
  return (
    <HostUsageSheet
      key={serverId}
      title={title}
      serverId={serverId}
      hosts={connectedHosts}
      onSelectHost={select}
      display={display}
    />
  );
}

function HostUsageSheet({
  title,
  serverId,
  hosts,
  onSelectHost,
  display,
}: {
  title: string;
  serverId: string;
  hosts: UsageHost[];
  onSelectHost: (serverId: string) => void;
  display: UsageDisplay;
}) {
  const hostSelection = useMemo(
    () => ({ hosts, serverId, onSelect: onSelectHost }),
    [hosts, onSelectHost, serverId],
  );
  const { view, refresh, controls } = useHostUsageWithControls(hostSelection, display);
  return (
    <SidebarPopoverSurface
      section="footer"
      title={title}
      sheetTrailing={controls}
      testID="sidebar-usage-sheet"
    >
      <View style={styles.sheetBody} testID="usage-expanded">
        <UsageBody serverId={serverId} view={view} display={display} onRefresh={refresh} />
      </View>
    </SidebarPopoverSurface>
  );
}

function pinnedUsageLabel(label: string, items: readonly PinnedUsageWindow[]): string {
  return `${label}: ${items.map((item) => `${item.label} ${item.percentText}`).join(", ")}`;
}

function triggerStyle({ hovered }: PressableStateCallbackType & { hovered?: boolean }) {
  return hovered ? [styles.trigger, styles.triggerHovered] : styles.trigger;
}

function PinnedUsageTrigger({
  label,
  items,
  onPress,
}: {
  label: string;
  items: readonly PinnedUsageWindow[];
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={pinnedUsageLabel(label, items)}
      style={triggerStyle}
      testID="sidebar-usage"
    >
      {items.map((item) => (
        <View key={item.key} style={styles.item} testID="sidebar-usage-pinned-window">
          <UsageSourceIcon svg={item.icon} size={14} />
          <Text style={styles.percent} numberOfLines={1}>
            {item.percentText}
          </Text>
        </View>
      ))}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    width: "100%",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    // A wrapping row packs its lines at the top; center them in the 28px row instead.
    alignContent: "center",
    columnGap: theme.spacing[3],
    rowGap: theme.spacing[1],
    // Same row geometry and leading rail as Add project and the footer icons.
    minHeight: 28,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1.5],
    borderRadius: theme.borderRadius.lg,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  percent: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  sheetBody: {
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
}));
