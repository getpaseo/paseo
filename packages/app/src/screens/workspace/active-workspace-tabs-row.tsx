import { useCallback, useMemo } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useRouter, type Href } from "expo-router";
import { CircleAlert, FolderGit2 } from "lucide-react-native";
import equal from "fast-deep-equal";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSessionStore } from "@/stores/session-store";
import { buildHostWorkspaceOpenRoute, buildHostWorkspaceRoute } from "@/utils/host-routes";
import type { Theme } from "@/styles/theme";
import {
  selectActiveWorkspaceTabs,
  type ActiveWorkspaceTab,
  type ActiveSessionStatus,
} from "./active-workspace-tabs-model";

const ThemedFolderGit = withUnistyles(FolderGit2);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const attentionColorMapping = (theme: Theme) => ({ color: theme.colors.palette.amber[500] });

function workspaceChipStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.workspaceChip, (Boolean(hovered) || pressed) && styles.workspaceChipHovered];
}

function statusDotStyle(status: ActiveSessionStatus) {
  if (status === "needs_input") return [styles.statusDot, styles.statusDotNeedsInput];
  if (status === "failed") return [styles.statusDot, styles.statusDotFailed];
  return [styles.statusDot, styles.statusDotRunning];
}

function ActiveWorkspaceChip({ tab, selected }: { tab: ActiveWorkspaceTab; selected: boolean }) {
  const router = useRouter();
  const navigateWorkspace = useCallback(() => {
    router.push(buildHostWorkspaceRoute(tab.serverId, tab.workspaceId) as Href);
  }, [router, tab.serverId, tab.workspaceId]);
  const navigateAttention = useCallback(
    (event: { stopPropagation?: () => void }) => {
      event.stopPropagation?.();
      const waitingSession = tab.sessions.find((session) => session.status === "needs_input");
      if (!waitingSession) {
        return;
      }
      router.push(
        buildHostWorkspaceOpenRoute(
          tab.serverId,
          tab.workspaceId,
          `agent:${waitingSession.agentId}`,
        ) as Href,
      );
    },
    [router, tab.serverId, tab.sessions, tab.workspaceId],
  );
  const accessibilityLabel = `${tab.projectLabel}, ${tab.workspaceLabel}, ${tab.sessions.length} active sessions`;
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const tooltip = `${tab.projectLabel} / ${tab.workspaceLabel}`;

  return (
    <Tooltip delayDuration={350} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        testID={`active-workspace-tab-${tab.key}`}
        onPress={navigateWorkspace}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={accessibilityState}
        style={workspaceChipStyle}
      >
        {selected ? <View style={styles.selectedIndicator} /> : null}
        <ThemedFolderGit size={14} uniProps={mutedColorMapping} />
        <Text style={styles.projectLabel} numberOfLines={1}>
          {tab.projectLabel}
        </Text>
        <Text style={styles.pathSeparator}>/</Text>
        <Text
          style={[styles.workspaceLabel, selected && styles.workspaceLabelSelected]}
          numberOfLines={1}
        >
          {tab.workspaceLabel}
        </Text>
        {tab.needsInputCount > 0 ? (
          <Pressable
            testID={`active-workspace-attention-${tab.key}`}
            accessibilityRole="button"
            accessibilityLabel={`${tab.needsInputCount} sessions need input`}
            onPress={navigateAttention}
            style={styles.attentionButton}
          >
            <ThemedCircleAlert size={14} uniProps={attentionColorMapping} />
            <Text style={styles.attentionCount}>{tab.needsInputCount}</Text>
          </Pressable>
        ) : (
          <View style={statusDotStyle(tab.status)} />
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom" align="center" offset={6}>
        <Text style={styles.tooltipText}>{tooltip}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

export function ActiveWorkspaceTabsRow({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const tabs = useStoreWithEqualityFn(useSessionStore, selectActiveWorkspaceTabs, equal);
  const contentStyle = useMemo(() => styles.content, []);

  if (tabs.length === 0) {
    return null;
  }

  return (
    <View style={styles.container} testID="active-workspace-tabs-row">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={contentStyle}
      >
        {tabs.map((tab) => (
          <ActiveWorkspaceChip
            key={tab.key}
            tab={tab}
            selected={tab.serverId === serverId && tab.workspaceId === workspaceId}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    height: 34,
    minWidth: 0,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  content: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  workspaceChip: {
    position: "relative",
    minWidth: 0,
    maxWidth: 300,
    paddingHorizontal: theme.spacing[3],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  workspaceChipHovered: {
    backgroundColor: theme.colors.surface2,
  },
  selectedIndicator: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
    backgroundColor: theme.colors.accent,
  },
  projectLabel: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  pathSeparator: {
    color: theme.colors.foregroundMuted,
    opacity: 0.6,
    fontSize: theme.fontSize.xs,
  },
  workspaceLabel: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  workspaceLabelSelected: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  statusDot: {
    width: 7,
    height: 7,
    flexShrink: 0,
    borderRadius: theme.borderRadius.full,
  },
  statusDotRunning: {
    backgroundColor: theme.colors.palette.blue[500],
  },
  statusDotNeedsInput: {
    backgroundColor: theme.colors.palette.amber[500],
  },
  statusDotFailed: {
    backgroundColor: theme.colors.palette.red[500],
  },
  attentionButton: {
    height: 22,
    minWidth: 22,
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  attentionCount: {
    color: theme.colors.palette.amber[500],
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  tooltipText: {
    color: theme.colors.popoverForeground,
    fontSize: theme.fontSize.sm,
  },
}));
