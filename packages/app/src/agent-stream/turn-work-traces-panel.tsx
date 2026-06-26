import React, { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import type { TurnTiming } from "@/timeline/turn-time";
import type { StreamItem } from "@/types/stream";
import { formatDuration, formatMessageTimestamp } from "@/utils/time";
import { STREAM_METADATA_FONT_SIZE } from "@/components/message";
import type { Theme } from "@/styles/theme";
import { isWeb } from "@/constants/platform";
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
  const [hovered, setHovered] = useState(false);
  const durationMs = timing?.durationMs;
  const completedAt = timing?.completedAt;
  const durationLabel = useMemo(
    () => (durationMs !== undefined ? `Worked for ${formatDuration(durationMs)}` : "Worked"),
    [durationMs],
  );
  const timestampLabel = useMemo(
    () => (completedAt ? formatMessageTimestamp(completedAt) : ""),
    [completedAt],
  );
  const canSwap = Boolean(timestampLabel);
  const showTimestamp = canSwap && hovered && isWeb;

  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);

  const Chevron = isExpanded ? ThemedChevronDown : ThemedChevronRight;

  return (
    <Pressable
      onPress={onToggle}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      accessibilityRole="button"
      accessibilityState={{ expanded: isExpanded }}
      accessibilityLabel={`${durationLabel}, work traces`}
      testID="turn-work-traces-header"
    >
      <View style={stylesheet.headerRow}>
        <Chevron size={14} uniProps={chevronColorMapping} />
        <Text style={stylesheet.headerLabel}>{showTimestamp ? timestampLabel : durationLabel}</Text>
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
    fontSize: STREAM_METADATA_FONT_SIZE,
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