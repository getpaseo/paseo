import { useCallback, useMemo } from "react";
import { ChevronDown, ChevronRight, GitBranch } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { treeRowPaddingLeft } from "@/components/tree-primitives";
import type { CheckoutDiffSubmodule } from "@/git/use-diff-query";
import type { Theme } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { SUBMODULE_HEADER_HEIGHT, SUBMODULE_STATUS_HEIGHT } from "@/git/diff-document/model";

const foregroundMutedIconColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const ThemedGitBranch = withUnistyles(GitBranch);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);

function buildHeaderTriggerStyle({ pressed }: PressableStateCallbackType) {
  return [styles.headerTrigger, pressed && styles.headerPressed];
}

interface DiffSubmoduleRowProps {
  submodule: CheckoutDiffSubmodule;
  onHeightChange?: (height: number) => void;
  testID?: string;
}

interface DiffSubmoduleHeaderProps extends DiffSubmoduleRowProps {
  bodyVisible: boolean;
  onToggle: (path: string) => void;
}

interface DiffSubmoduleStatusProps extends DiffSubmoduleRowProps {
  depth: number;
  diffMode: "uncommitted" | "base";
}

function shortSha(sha: string | null | undefined): string {
  return sha?.slice(0, 7) ?? "";
}

export function DiffSubmoduleHeader({
  submodule,
  bodyVisible,
  onToggle,
  onHeightChange,
  testID,
}: DiffSubmoduleHeaderProps) {
  const { t } = useTranslation();
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onHeightChange?.(event.nativeEvent.layout.height),
    [onHeightChange],
  );
  const isDetached = submodule.branch === null && submodule.currentSha !== null;
  const handleToggle = useCallback(() => onToggle(submodule.path), [onToggle, submodule.path]);
  const accessibilityState = useMemo(() => ({ expanded: bodyVisible }), [bodyVisible]);
  let refLabel: string;
  if (submodule.branch !== null) {
    refLabel = submodule.branch;
  } else if (isDetached) {
    refLabel = t("workspace.git.diff.submodule.detached", {
      sha: shortSha(submodule.currentSha),
    });
  } else if (submodule.checkoutState === "uninitialized") {
    refLabel = t("workspace.git.diff.submodule.notInitialized");
  } else {
    refLabel = t("workspace.git.diff.submodule.unavailable");
  }

  return (
    <View style={styles.header} accessibilityRole="header" onLayout={handleLayout} testID={testID}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        aria-expanded={bodyVisible}
        onPress={handleToggle}
        style={buildHeaderTriggerStyle}
      >
        <View style={styles.headerIdentity}>
          {bodyVisible ? (
            <ThemedChevronDown size={14} uniProps={foregroundMutedIconColorMapping} />
          ) : (
            <ThemedChevronRight size={14} uniProps={foregroundMutedIconColorMapping} />
          )}
          <ThemedGitBranch size={14} uniProps={foregroundMutedIconColorMapping} />
          <Text style={styles.path} numberOfLines={1}>
            {submodule.path}
          </Text>
        </View>
        <Text style={isDetached ? [styles.ref, styles.detachedRef] : styles.ref} numberOfLines={1}>
          {refLabel}
        </Text>
      </Pressable>
    </View>
  );
}

export function DiffSubmoduleStatus({
  submodule,
  depth,
  diffMode,
  onHeightChange,
  testID,
}: DiffSubmoduleStatusProps) {
  const { t } = useTranslation();
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onHeightChange?.(event.nativeEvent.layout.height),
    [onHeightChange],
  );
  const rowStyle = useMemo(
    () => [styles.status, inlineUnistylesStyle({ paddingLeft: treeRowPaddingLeft(depth) })],
    [depth],
  );

  let label: string;
  if (submodule.changeState === "added") {
    label = t("workspace.git.diff.submodule.added");
  } else if (submodule.changeState === "deleted") {
    label = t("workspace.git.diff.submodule.deleted");
  } else if (submodule.changeState === "history_unavailable") {
    label = t("workspace.git.diff.submodule.historyUnavailable");
  } else if (submodule.checkoutState === "uninitialized") {
    label = t("workspace.git.diff.submodule.notInitialized");
  } else if (submodule.checkoutState !== "checked_out") {
    label = t("workspace.git.diff.submodule.unavailable");
  } else if (submodule.changeState === "head_differs") {
    label = t("workspace.git.diff.submodule.headDiffers", {
      currentSha: shortSha(submodule.currentSha),
      pinnedSha: shortSha(submodule.headPinnedSha),
    });
  } else if (
    diffMode === "uncommitted" &&
    ["clean", "worktree_modified"].includes(submodule.changeState)
  ) {
    label = t("workspace.git.diff.emptyUncommitted");
  } else if (diffMode === "base" && ["clean", "recorded_change"].includes(submodule.changeState)) {
    label = t("workspace.git.diff.submodule.emptyCommitted");
  } else {
    label = t("workspace.git.diff.submodule.historyUnavailable");
  }

  return (
    <View style={rowStyle} onLayout={handleLayout} testID={testID}>
      <Text style={styles.statusText} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  header: {
    height: SUBMODULE_HEADER_HEIGHT,
    minWidth: 0,
    backgroundColor: theme.colors.surface1,
  },
  headerTrigger: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 0,
    borderTopWidth: theme.borderWidth[1],
    borderBottomWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  headerPressed: {
    backgroundColor: theme.colors.surface2,
  },
  headerIdentity: {
    minWidth: 0,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  path: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  ref: {
    maxWidth: "45%",
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  detachedRef: {
    fontFamily: theme.fontFamily.mono,
  },
  status: {
    position: "relative",
    height: SUBMODULE_STATUS_HEIGHT,
    alignItems: "center",
    flexDirection: "row",
    paddingRight: theme.spacing[3],
    paddingVertical: 0,
  },
  statusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
