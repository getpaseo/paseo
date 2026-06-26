import React, { memo, useMemo, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import type { TurnTiming } from "@/timeline/turn-time";
import { formatDuration } from "@/utils/time";
import type { Theme } from "@/styles/theme";
import type { StreamLayoutItem } from "./layout";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const chevronColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export const TurnWorkTracesHeader = memo(function TurnWorkTracesHeader({
  timing,
  isExpanded,
  onToggle,
}: {
  timing: TurnTiming | null;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const durationMs = timing?.durationMs;
  const durationLabel = useMemo(
    () => (durationMs !== undefined ? `Worked for ${formatDuration(durationMs)}` : "Worked"),
    [durationMs],
  );

  const Chevron = isExpanded ? ThemedChevronDown : ThemedChevronRight;

  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded: isExpanded }}
      accessibilityLabel={`${durationLabel}, work traces`}
      testID="turn-work-traces-header"
    >
      <View style={stylesheet.headerRow}>
        <Chevron size={14} uniProps={chevronColorMapping} />
        <Text style={stylesheet.headerLabel}>{durationLabel}</Text>
      </View>
    </Pressable>
  );
});

export const TurnWorkTracesPanel = memo(function TurnWorkTracesPanel({
  timing,
  isExpanded,
  onToggle,
  traceItems,
  renderTraceLayoutItem,
}: {
  timing: TurnTiming | null;
  isExpanded: boolean;
  onToggle: () => void;
  traceItems: StreamLayoutItem[];
  renderTraceLayoutItem: (layoutItem: StreamLayoutItem) => ReactNode;
}) {
  return (
    <View style={stylesheet.panel}>
      <TurnWorkTracesHeader timing={timing} isExpanded={isExpanded} onToggle={onToggle} />
      {isExpanded ? (
        <View style={stylesheet.traceBody}>
          {traceItems.map((layoutItem) => (
            <View key={layoutItem.item.id} style={stylesheet.traceRow}>
              {renderTraceLayoutItem(layoutItem)}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
});

const stylesheet = StyleSheet.create((theme) => ({
  panel: {
    paddingTop: theme.spacing[1],
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 24,
  },
  headerLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  traceBody: {
    paddingTop: theme.spacing[2],
    gap: 0,
  },
  traceRow: {
    width: "100%",
  },
}));