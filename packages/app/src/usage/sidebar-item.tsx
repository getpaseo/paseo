import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react-native";
import { Text, View, type LayoutChangeEvent, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { Theme } from "@/styles/theme";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAppVisible } from "@/hooks/use-app-visible";
import { builtinSidebarNavLabelKey } from "@/sidebar-nav/model";
import { useUsageDisplay } from "./display";
import { useUsageInSidebar } from "./in-sidebar";
import { useUsageHostId } from "./hosts";
import { useUsageHostReports } from "./queries";
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
import { UsageModal } from "./usage-modal";

const ThemedTriangleAlert = withUnistyles(TriangleAlert);
const errorIconColor = (theme: Theme) => ({ color: theme.colors.statusDanger });

/** Each summary window with data on the usage host, under its source; empty while none has. */
export function useUsageSummary(): readonly PinnedUsageSource[] {
  const { t } = useTranslation();
  const active = useRetainedPanelActive();
  const isAppVisible = useAppVisible();
  const { inSidebar } = useUsageInSidebar();
  const serverId = useUsageHostId();
  const reports = useUsageHostReports({
    serverId: inSidebar ? serverId : null,
    shouldPoll: active && inSidebar && isAppVisible,
  });
  const { preferences } = useUsageDisplay(reports);
  return useMemo(() => resolvePinnedUsage(reports, preferences, t), [preferences, reports, t]);
}

/**
 * The sidebar footer's usage entry: each summary window's source icon and percent, and nothing
 * while no summary window has data, since the footer's Usage icon already opens Usage.
 * Pressing it opens the Usage modal.
 */
export function UsageSidebarItem({ sources }: { sources: readonly PinnedUsageSource[] }) {
  const { t } = useTranslation();
  const label = t(builtinSidebarNavLabelKey("usage"));
  const openUsage = useOpenSidebarUsage();
  if (sources.length === 0) return null;
  return (
    <PinnedUsageTrigger
      label={label}
      sources={sources}
      errorLabel={t("providerUsage.refreshFailed")}
      onPress={openUsage}
    />
  );
}

const OpenSidebarUsageContext = createContext<(() => void) | null>(null);

/**
 * One owner for the footer icon and summary: both open the Usage modal over the current screen.
 * The modal mounts on first open and unmounts once it has finished closing, so its host's reports
 * load only while it is shown.
 */
export function UsageSidebarRoot({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const openUsage = useCallback(() => {
    setMounted(true);
    setOpen(true);
  }, []);
  const closeUsage = useCallback(() => setOpen(false), []);
  const unmountUsage = useCallback(() => setMounted(false), []);

  return (
    <OpenSidebarUsageContext.Provider value={openUsage}>
      {children}
      {mounted ? <UsageModal visible={open} onClose={closeUsage} onDismiss={unmountUsage} /> : null}
    </OpenSidebarUsageContext.Provider>
  );
}

/** Both sidebar entry points send the same open command. */
export function useOpenSidebarUsage(): () => void {
  const openUsage = useContext(OpenSidebarUsageContext);
  if (!openUsage) throw new Error("Sidebar Usage must be inside UsageSidebarRoot.");
  return openUsage;
}

function pinnedUsageLabel(
  label: string,
  sources: readonly PinnedUsageSource[],
  errorLabel: string,
): string {
  const windows = sources.flatMap((source) => source.windows);
  const summary = windows.map((window) => window.label).join(", ");
  const error = sources.some((source) => source.hasError) ? `, ${errorLabel}` : "";
  return `${label}: ${summary}${error}`;
}

function triggerStyle({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.trigger, hovered && styles.triggerHovered, pressed && styles.triggerPressed];
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
  errorLabel,
  onPress,
}: {
  label: string;
  sources: readonly PinnedUsageSource[];
  errorLabel: string;
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
    <PressHighlight
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={pinnedUsageLabel(label, sources, errorLabel)}
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
    </PressHighlight>
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
        style={[styles.source, sourceIndex === 0 ? null : styles.sourceGap]}
        testID={measuring ? undefined : "sidebar-usage-source"}
      >
        <UsageSourceIcon svg={source.icon} size={14} />
        {source.hasError ? (
          <ThemedTriangleAlert
            size={12}
            uniProps={errorIconColor}
            testID={measuring ? undefined : "sidebar-usage-error"}
          />
        ) : null}
      </View>
      {source.windows.map((window, windowIndex) => {
        const leadStyle = windowIndex === 0 ? styles.iconGap : styles.windowGap;
        return (
          <Fragment key={window.key}>
            {layout === "meters" ? (
              <View style={[styles.meterSlot, leadStyle]}>
                <UsageMeter percent={window.percent} tone={window.tone} quiet />
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
  triggerPressed: {
    backgroundColor: theme.colors.surface2,
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
  source: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
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
  percent: {
    flexShrink: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  windowLabel: {
    color: theme.colors.foregroundMuted,
  },
}));
