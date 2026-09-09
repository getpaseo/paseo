import { Pin } from "lucide-react-native";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usageCopy } from "./copy";
import {
  formatDisplayPct,
  formatProviderUsageLabel,
  formatResetLabel,
  formatRunsOutLabel,
} from "./format";
import { UsageMeter } from "./meter";
import { displayPercent, usageWindowRowLabel } from "./model";
import type { UsageDisplayAs } from "./preferences";
import { windowTone } from "./tone";
import type { UsageTone, UsageWindow } from "./types";
import { useRelativeTimeTick } from "./use-relative-time-tick";

// Pinned rows carry the pinned surface; hovering an unpinned row previews it at half strength,
// so a hover never reads as the selection. Pinned rows do not react to hover.
function highlightStyle(pinned: boolean, hovered: boolean) {
  if (pinned) return styles.highlightPinned;
  return hovered ? styles.highlightHovered : styles.highlightNone;
}

export function UsageWindowBar({
  window,
  displayAs,
  pinned,
  onTogglePin,
  pinLabel,
  pinTestID,
}: {
  window: UsageWindow;
  displayAs: UsageDisplayAs;
  pinned: boolean;
  onTogglePin: () => void;
  /** What the row pins, naming the source and window: "Pin Claude Session". */
  pinLabel: string;
  pinTestID: string;
}) {
  const { i18n } = useTranslation();
  const shownPct = displayPercent(window, displayAs);
  const tone = windowTone(window);

  const isAtRisk = window.runsOutAt != null && window.shortfallPct != null;
  const relativeTime = isAtRisk ? window.runsOutAt : window.resetsAt;
  useRelativeTimeTick(relativeTime != null);
  const relativeTime = isAtRisk ? window.runsOutAt : window.resetsAt;
  useRelativeTimeTick(relativeTime != null);
  const trailing = isAtRisk
    ? formatRunsOutLabel(window.runsOutAt)
    : formatResetLabel(window.resetsAt);

  const value =
    shownPct != null ? formatDisplayPct(shownPct, displayAs, i18n.resolvedLanguage) : "—";
  const accessibilityState = useMemo(() => ({ checked: pinned }), [pinned]);

  // The whole row pins the window to the sidebar Usage item. Pinned or not, it keeps the same
  // padding so toggling only changes the background.
  return (
    <Pressable
      onPress={onTogglePin}
      accessibilityRole="checkbox"
      accessibilityLabel={usageWindowRowLabel({ pinLabel, value, trailing })}
      accessibilityState={accessibilityState}
      aria-checked={pinned}
      style={styles.row}
      testID={pinTestID}
    >
      {({ hovered }: { hovered?: boolean }) => (
        <WindowRowContent
          highlight={highlightStyle(pinned, Boolean(hovered))}
          label={formatProviderUsageLabel(window.id, window.label)}
          value={value}
          trailing={trailing}
          isAtRisk={isAtRisk}
          percent={shownPct ?? 0}
          tone={tone}
          pinned={pinned}
        />
      )}
    </Pressable>
  );
}

function WindowRowContent({
  highlight,
  label,
  value,
  trailing,
  isAtRisk,
  percent,
  tone,
  pinned,
}: {
  highlight: StyleProp<ViewStyle>;
  label: string;
  value: string;
  trailing: string | null | undefined;
  isAtRisk: boolean;
  percent: number;
  tone: UsageTone;
  pinned: boolean;
}) {
  return (
    <>
      <View style={highlight} pointerEvents="none" />
      <View style={styles.contentRow}>
        <View style={styles.windowContent}>
          <View style={styles.labelRow}>
            <Text style={styles.label} numberOfLines={1}>
              {label}
            </Text>
            <Text style={styles.value} numberOfLines={1} ellipsizeMode="tail">
              {value}
              {trailing ? (
                <Text style={isAtRisk ? styles.atRisk : styles.reset}>{` · ${trailing}`}</Text>
              ) : null}
            </Text>
          </View>
          <UsageMeter percent={percent} tone={tone} />
        </View>
        <UsagePinGlyph pinned={pinned} />
      </View>
    </>
  );
}

const ThemedPin = withUnistyles(Pin);

function UsagePinGlyph({ pinned }: { pinned: boolean }) {
  const iconMapping = useMemo(
    () => (theme: { colors: { foregroundMuted: string } }) => ({
      color: theme.colors.foregroundMuted,
      fill: pinned ? theme.colors.foregroundMuted : "none",
    }),
    [pinned],
  );
  return (
    <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <View
          style={styles.pin}
          testID={pinned ? "usage-pin-glyph-pinned" : "usage-pin-glyph-unpinned"}
        >
          <ThemedPin size={12} uniProps={iconMapping} />
        </View>
      </TooltipTrigger>
      <TooltipContent side="top">
        <Text style={styles.tooltipText}>{pinned ? usageCopy.unpin : usageCopy.pin}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  contentRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  windowContent: { flex: 1, gap: 3 },
  pin: { width: 12, alignItems: "center" },
  tooltipText: { color: theme.colors.popoverForeground, fontSize: theme.fontSize.sm },
  row: {
    gap: 3,
    // The highlight bleeds into the card padding so the label and bar stay on the card's rail.
    marginHorizontal: -theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    // Its own stacking context, so the highlight layer paints above the card and below the text.
    zIndex: 0,
  },
  highlightNone: {
    display: "none",
  },
  highlightPinned: {
    ...StyleSheet.absoluteFillObject,
    zIndex: -1,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  // The pinned surface at half strength: a separate layer, so the text keeps full opacity.
  highlightHovered: {
    ...StyleSheet.absoluteFillObject,
    zIndex: -1,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    opacity: theme.opacity[50],
  },
  labelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  label: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  value: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  reset: {
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.normal,
  },
  atRisk: {
    color: theme.colors.statusDanger,
    fontWeight: theme.fontWeight.normal,
  },
}));
