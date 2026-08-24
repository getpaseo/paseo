import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ClassifiedCheckoutCommit } from "@/git/use-commits-query";

interface CommitGraphNodeProps {
  commit: ClassifiedCheckoutCommit;
  isFirst: boolean;
  isLast: boolean;
}

export function CommitGraphNode({ commit, isFirst, isLast }: CommitGraphNodeProps) {
  const isOnBase = commit.isOnBase;
  const railColor = isOnBase ? styles.railBase : styles.railWorkspace;
  const markerColor = isOnBase ? styles.markerBase : styles.markerWorkspace;

  return (
    <View style={styles.container}>
      {isFirst && isLast ? null : (
        <View
          style={[styles.rail, railColor, isFirst && styles.railFirst, isLast && styles.railLast]}
        />
      )}
      <View
        testID={commit.isOnRemote ? "commit-dot-remote" : "commit-dot-local"}
        style={[styles.marker, markerColor, !commit.isOnRemote && styles.markerRing]}
      />
    </View>
  );
}

const MARKER_SIZE = 8;
const RAIL_WIDTH = 2;

const styles = StyleSheet.create((theme) => ({
  container: {
    width: MARKER_SIZE,
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    flexShrink: 0,
  },
  rail: {
    position: "absolute",
    top: -theme.spacing[1] - 1,
    bottom: -theme.spacing[1] - 1,
    width: RAIL_WIDTH,
  },
  railFirst: {
    top: "50%",
  },
  railLast: {
    bottom: "50%",
  },
  railBase: {
    backgroundColor: theme.colors.foregroundMuted,
  },
  railWorkspace: {
    backgroundColor: theme.colors.accent,
  },
  marker: {
    width: MARKER_SIZE,
    height: MARKER_SIZE,
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[2],
    zIndex: 1,
  },
  markerBase: {
    backgroundColor: theme.colors.foregroundMuted,
    borderColor: theme.colors.foregroundMuted,
  },
  markerWorkspace: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  markerRing: {
    backgroundColor: theme.colors.surface0,
  },
}));
