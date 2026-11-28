import { memo, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { STREAM_METADATA_FONT_SIZE } from "@/components/message";
import { formatDuration, formatItemTimestamp } from "@/utils/time";
import { ITEM_TIME_CARD_BLEED, ITEM_TIME_SIDE_GAP, type ItemTime } from "./item-times";

/**
 * The time a chat row finished and how long its step took. With a `sideWidth` it sits level
 * with the row's end in the margin beside the chat column (the left margin, moved `sideInset`
 * further out for rows indented under a turn summary; your own messages use the right margin),
 * and the row must be its containing block. Without one it sits under the row.
 */
export const ItemTimeLine = memo(function ItemTimeLine({
  time,
  align,
  sideWidth,
  sideInset,
}: {
  time: ItemTime;
  align: "start" | "end";
  sideWidth: number | null;
  sideInset: number;
}) {
  const { t } = useTranslation();
  const label = useMemo(() => {
    const at = formatItemTimestamp(time.at);
    return time.tookMs === null
      ? at
      : t("agentStream.itemTime.withDuration", { time: at, duration: formatDuration(time.tookMs) });
  }, [t, time.at, time.tookMs]);
  const rowStyle = useMemo(() => {
    if (sideWidth === null) {
      return [stylesheet.row, align === "end" ? stylesheet.rowEnd : null];
    }
    return [
      stylesheet.side,
      align === "end"
        ? { left: "100%" as const, marginLeft: ITEM_TIME_SIDE_GAP }
        : {
            right: "100%" as const,
            marginRight: ITEM_TIME_CARD_BLEED + ITEM_TIME_SIDE_GAP + sideInset,
          },
      { width: sideWidth },
    ];
  }, [align, sideInset, sideWidth]);
  const labelStyle = useMemo(() => {
    if (sideWidth === null) return [stylesheet.label];
    return [stylesheet.label, align === "end" ? stylesheet.labelStart : stylesheet.labelEnd];
  }, [align, sideWidth]);
  return (
    <View style={rowStyle} pointerEvents="none" testID="item-time-line">
      <Text style={labelStyle} selectable={false}>
        {label}
      </Text>
    </View>
  );
});

const stylesheet = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    justifyContent: "flex-start",
    marginTop: theme.spacing[1],
  },
  rowEnd: {
    justifyContent: "flex-end",
  },
  side: {
    position: "absolute",
    bottom: 0,
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE - 1,
    fontVariant: ["tabular-nums"],
  },
  labelStart: {
    textAlign: "left",
  },
  labelEnd: {
    textAlign: "right",
  },
}));
