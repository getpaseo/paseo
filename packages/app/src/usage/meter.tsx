import { useMemo } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { clampPct } from "./format";
import type { UsageTone } from "./types";

function fillToneStyle(tone: UsageTone) {
  switch (tone) {
    case "ok":
      return styles.fillOk;
    case "warning":
      return styles.fillWarning;
    case "danger":
      return styles.fillDanger;
    default:
      return styles.fillDefault;
  }
}

/**
 * A window's share as a bar, coloured by its tone. `quiet` fills it with a surface colour instead,
 * for summaries where a row of coloured bars would be noise. The caller sizes the track.
 */
export function UsageMeter({
  percent,
  tone,
  quiet = false,
  style,
}: {
  percent: number;
  tone: UsageTone;
  quiet?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const fillWidth = clampPct(percent);
  const fillStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.fill, quiet ? styles.fillQuiet : fillToneStyle(tone), { width: `${fillWidth}%` }],
    [fillWidth, quiet, tone],
  );
  return (
    <View style={[styles.track, style]}>
      <View style={fillStyle} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  // Follows the track, so a caller that sizes the track sizes the bar.
  fill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
  },
  fillQuiet: {
    backgroundColor: theme.colors.surface4,
  },
  fillDefault: {
    backgroundColor: theme.colors.foregroundMuted,
  },
  fillOk: {
    backgroundColor: theme.colors.statusSuccess,
  },
  fillWarning: {
    backgroundColor: theme.colors.statusWarning,
  },
  fillDanger: {
    backgroundColor: theme.colors.statusDanger,
  },
}));
