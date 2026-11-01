import type { ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

export type GoalBarTone = "neutral" | "success" | "warning" | "danger";

/** Extra windows drawn over the fill: a review in the foreground color, a merge in the merged one. */
export interface GoalBarSegment {
  key: string;
  offset: number;
  fraction: number;
  kind: "review" | "merge";
}

function percent(value: number): `${number}%` {
  return `${Math.round(Math.min(1, Math.max(0, value)) * 1000) / 10}%`;
}

/**
 * A thin horizontal bar: a fill from `offset` across `fraction` of the track. Used for overall
 * progress, budgets and the per-task timeline, where `segments` add the review and merge windows.
 */
export function GoalBar({
  fraction,
  offset = 0,
  tone = "neutral",
  segments,
  testID,
}: {
  fraction: number;
  offset?: number;
  tone?: GoalBarTone;
  segments?: readonly GoalBarSegment[];
  testID?: string;
}): ReactElement {
  return (
    <View style={styles.track} testID={testID}>
      <View
        style={[
          styles.fill,
          tone === "success" && styles.fillSuccess,
          tone === "warning" && styles.fillWarning,
          tone === "danger" && styles.fillDanger,
          inlineUnistylesStyle({ width: percent(fraction), left: percent(offset) }),
        ]}
      />
      {segments?.map((segment) => (
        <View
          key={segment.key}
          style={[
            styles.fill,
            segment.kind === "review" ? styles.fillReview : styles.fillMerge,
            inlineUnistylesStyle({
              width: percent(segment.fraction),
              left: percent(segment.offset),
            }),
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  track: {
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  fill: {
    position: "absolute",
    top: 0,
    bottom: 0,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  fillSuccess: {
    backgroundColor: theme.colors.statusSuccess,
  },
  fillWarning: {
    backgroundColor: theme.colors.statusWarning,
  },
  fillDanger: {
    backgroundColor: theme.colors.statusDanger,
  },
  fillReview: {
    backgroundColor: theme.colors.foreground,
  },
  fillMerge: {
    backgroundColor: theme.colors.statusMerged,
  },
}));
