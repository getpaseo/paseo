// Bottom-of-window pill that surfaces background Claude Code install
// progress during first run. The desktop app kicks ensureClaudeCode() at
// boot — without this banner the user sees nothing until they happen to
// open Settings → Providers. Goes away as soon as install reaches "complete"
// or "idle"; resurfaces on subsequent boots only if a re-install is needed
// (e.g. after we bump PINNED_CLAUDE_CODE_VERSION).

import { useMemo } from "react";
import { View, Text, ActivityIndicator } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  useHubcodeClaudeInstaller,
  describeProgress,
  progressFraction,
} from "@/desktop/integrations/use-hubcode-claude-installer";
import { getIsElectron } from "@/constants/platform";

export function ClaudeCodeInstallBanner() {
  if (!getIsElectron()) return null;
  return <Inner />;
}

function Inner() {
  const { progress } = useHubcodeClaudeInstaller();

  const isActive = useMemo(
    () =>
      progress.phase === "checking" ||
      progress.phase === "downloading-node" ||
      progress.phase === "extracting-node" ||
      progress.phase === "installing-claude-code",
    [progress.phase],
  );

  if (!isActive) return null;

  const fraction = progressFraction(progress);
  const label = describeProgress(progress);

  return (
    <View pointerEvents="none" style={styles.wrap}>
      <View style={styles.pill}>
        <ActivityIndicator size="small" />
        <View style={styles.copy}>
          <Text style={styles.title}>Setting up Hubcode runtime</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {label}
          </Text>
        </View>
        {fraction !== null ? (
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${Math.round(fraction * 100)}%` }]} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 16,
    alignItems: "center",
    pointerEvents: "none" as const,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: 999,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 4,
    minWidth: 280,
    maxWidth: 420,
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  track: {
    width: 80,
    height: 4,
    backgroundColor: theme.colors.muted,
    borderRadius: 2,
    overflow: "hidden",
  },
  fill: {
    height: "100%",
    backgroundColor: theme.colors.primary,
    borderRadius: 2,
  },
}));
