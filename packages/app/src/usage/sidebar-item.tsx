import { router } from "expo-router";
import { CircleGauge } from "lucide-react-native";
import { Fragment, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
} from "react-native";
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
import { UsageMeter } from "./meter";
import {
  choosePinnedUsageLayout,
  METER_GAP,
  MIN_METER_WIDTH,
  resolvePinnedUsage,
  type PinnedUsageLayout,
  type PinnedUsageSource,
} from "./pinned";
import type { UsageReportEntry } from "./types";
import type { UsageHost } from "./model";
import { UsageBody } from "./usage-section";

const NO_REPORTS: UsageReportEntry[] = [];
const NO_SOURCES: PinnedUsageSource[] = [];

/**
 * The sidebar footer's usage entry: each summary window's source icon and percent, or a plain
 * "Usage" row while no summary window has data. Pressing it opens the Usage screen; on compact
 * layouts it opens the usage sheet instead.
 */
export function UsageSidebarItem() {
  const { preferences, display } = useUsagePreferences();
  const serverId = useUsageHostId();
  if (!serverId) {
    return <UsageEntry serverId={serverId} sources={NO_SOURCES} display={display} />;
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
  const sources = useMemo(() => resolvePinnedUsage(reports, preferences), [preferences, reports]);
  return <UsageEntry serverId={serverId} sources={sources} display={display} />;
}

/** Opens the Usage screen, over the sidebar on compact layouts. */
export function useOpenUsageScreen(): () => void {
  const isCompact = useIsCompactFormFactor();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  return useCallback(() => {
    if (isCompact) showMobileAgent();
    router.push(buildUsageRoute());
  }, [isCompact, showMobileAgent]);
}

function UsageEntry({
  serverId,
  sources,
  display,
}: {
  serverId: string | null;
  sources: readonly PinnedUsageSource[];
  display: UsageDisplay;
}) {
  const { t } = useTranslation();
  const label = t(builtinSidebarNavLabelKey("usage"));
  const isCompact = useIsCompactFormFactor();
  const openUsageScreen = useOpenUsageScreen();
  const [open, setOpen] = useState(false);
  // The sheet mounts on first open; the summary already owns the report query.
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
    sources.length > 0 ? (
      <PinnedUsageTrigger label={label} sources={sources} onPress={handlePress} />
    ) : (
      <SidebarHeaderRow
        variant="inline"
        icon={CircleGauge}
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

function pinnedUsageLabel(label: string, sources: readonly PinnedUsageSource[]): string {
  const windows = sources.flatMap((source) => source.windows);
  return `${label}: ${windows.map((window) => window.label).join(", ")}`;
}

function triggerStyle({ hovered }: PressableStateCallbackType & { hovered?: boolean }) {
  return hovered ? [styles.trigger, styles.triggerHovered] : styles.trigger;
}

function layoutWidth(event: LayoutChangeEvent): number {
  return event.nativeEvent.layout.width;
}

/**
 * One line: each account's icon, then per window a meter and "31% 5h". Off-screen copies measure
 * the line with labels and with percents alone; the richest layout that fits is shown, and what
 * it leaves out takes no space at all.
 */
function PinnedUsageTrigger({
  label,
  sources,
  onPress,
}: {
  label: string;
  sources: readonly PinnedUsageSource[];
  onPress: () => void;
}) {
  const [available, setAvailable] = useState<number | null>(null);
  const [labelsWidth, setLabelsWidth] = useState<number | null>(null);
  const [percentsWidth, setPercentsWidth] = useState<number | null>(null);
  const handleAvailableLayout = useCallback((event: LayoutChangeEvent) => {
    setAvailable(layoutWidth(event));
  }, []);
  const handleLabelsLayout = useCallback((event: LayoutChangeEvent) => {
    setLabelsWidth(layoutWidth(event));
  }, []);
  const handlePercentsLayout = useCallback((event: LayoutChangeEvent) => {
    setPercentsWidth(layoutWidth(event));
  }, []);
  const layout = choosePinnedUsageLayout({
    available,
    labelsWidth,
    percentsWidth,
    windowCount: sources.reduce((count, source) => count + source.windows.length, 0),
  });
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={pinnedUsageLabel(label, sources)}
      style={triggerStyle}
      testID="sidebar-usage"
    >
      <View style={styles.line} onLayout={handleAvailableLayout}>
        <PinnedUsageLine sources={sources} layout={layout} />
      </View>
      <View
        style={styles.measure}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        aria-hidden
      >
        <View style={styles.measured} onLayout={handleLabelsLayout}>
          <PinnedUsageLine sources={sources} layout="labels" measuring />
        </View>
        <View style={styles.measured} onLayout={handlePercentsLayout}>
          <PinnedUsageLine sources={sources} layout="percents" measuring />
        </View>
      </View>
    </Pressable>
  );
}

/**
 * The line's items as direct children of one row, so every meter shares the leftover width
 * equally.
 */
function PinnedUsageLine({
  sources,
  layout,
  measuring = false,
}: {
  sources: readonly PinnedUsageSource[];
  layout: PinnedUsageLayout;
  measuring?: boolean;
}) {
  return sources.map((source, sourceIndex) => (
    <Fragment key={source.key}>
      <View
        style={sourceIndex === 0 ? null : styles.sourceGap}
        testID={measuring ? undefined : "sidebar-usage-source"}
      >
        <UsageSourceIcon svg={source.icon} size={14} />
      </View>
      {source.windows.map((window, windowIndex) => {
        const leadStyle = windowIndex === 0 ? styles.iconGap : styles.windowGap;
        return (
          <Fragment key={window.key}>
            {layout === "meters" ? (
              <View style={[styles.meterSlot, leadStyle]}>
                <UsageMeter
                  percent={window.percent}
                  tone={window.tone}
                  quiet
                  style={styles.meter}
                />
              </View>
            ) : null}
            <Text
              style={[styles.percent, layout === "meters" ? null : leadStyle]}
              numberOfLines={1}
              testID={measuring ? undefined : "sidebar-usage-pinned-window"}
            >
              {window.percentText}
              {layout === "percents" || window.shortLabel === "" ? null : (
                <Text style={styles.windowLabel}>{` ${window.shortLabel}`}</Text>
              )}
            </Text>
          </Fragment>
        );
      })}
    </Fragment>
  ));
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
    // Same row geometry and leading rail as Add project and the footer icons.
    minHeight: 28,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  line: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
  },
  // Wide enough that nothing inside wraps or shrinks; each child reports its natural width.
  measure: {
    position: "absolute",
    top: 0,
    left: 0,
    width: 10_000,
    opacity: 0,
  },
  measured: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
  },
  sourceGap: {
    marginLeft: theme.spacing[3],
  },
  iconGap: {
    marginLeft: theme.spacing[1.5],
  },
  windowGap: {
    marginLeft: theme.spacing[2],
  },
  // Every slot takes an equal share of the leftover width, so the line fills the row.
  meterSlot: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: MIN_METER_WIDTH,
    marginRight: METER_GAP,
  },
  meter: {
    height: 6,
    borderRadius: 3,
  },
  percent: {
    flexShrink: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  windowLabel: {
    color: theme.colors.foregroundMuted,
  },
  sheetBody: {
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
}));
