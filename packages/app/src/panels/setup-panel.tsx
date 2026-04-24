import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ChevronRight, CircleAlert, SquareTerminal } from "lucide-react-native";
import {
  ActivityIndicator,
  Pressable,
  type PressableStateCallbackType,
  ScrollView,
  Text,
  View,
} from "react-native";
import invariant from "tiny-invariant";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Fonts } from "@/constants/theme";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { buildWorkspaceTabPersistenceKey } from "@/stores/workspace-tabs-store";
import {
  useWorkspaceSetupStore,
  type WorkspaceSetupSnapshot,
} from "@/stores/workspace-setup-store";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

function useSetupPanelDescriptor(
  target: { kind: "setup"; workspaceId: string },
  context: { serverId: string; workspaceId: string },
): PanelDescriptor {
  const key = buildWorkspaceTabPersistenceKey({
    serverId: context.serverId,
    workspaceId: target.workspaceId,
  });
  const snapshot = useWorkspaceSetupStore((state) => (key ? (state.snapshots[key] ?? null) : null));

  if (snapshot?.status === "completed") {
    return {
      label: "Setup",
      subtitle: "Setup completed",
      titleState: "ready",
      icon: CheckCircle2,
      statusBucket: null,
    };
  }

  if (snapshot?.status === "failed") {
    return {
      label: "Setup",
      subtitle: "Setup failed",
      titleState: "ready",
      icon: CircleAlert,
      statusBucket: null,
    };
  }

  return {
    label: "Setup",
    subtitle: "Workspace setup",
    titleState: "ready",
    icon: SquareTerminal,
    statusBucket: snapshot?.status === "running" ? "running" : null,
  };
}

type CommandStatus = "running" | "completed" | "failed";

function CommandStatusIcon({ status }: { status: CommandStatus }) {
  const { theme } = useUnistyles();

  if (status === "running") {
    return <ActivityIndicator size={14} color={theme.colors.foreground} />;
  }
  if (status === "completed") {
    return <CheckCircle2 size={14} color={theme.colors.palette.green[500]} />;
  }
  return <CircleAlert size={14} color={theme.colors.palette.red[500]} />;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Process carriage returns in log text so progress-bar output renders cleanly.
 * Splits on \r, keeps only the last segment per CR-delimited group (unless followed by \n).
 */
function processCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const segments = line.split("\r");
      return segments[segments.length - 1];
    })
    .join("\n");
}

type SetupCommand = WorkspaceSetupSnapshot["detail"]["commands"][number];

function resolveAutoExpandIndex(commands: { index: number; status: string }[]): number | null {
  const running = commands.find((c) => c.status === "running");
  if (running) return running.index;
  if (commands.length > 0) return commands[commands.length - 1].index;
  return null;
}

function resolveSetupStatusLabel(status: string | undefined): string {
  if (status === "running") return "Running";
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  return "Waiting for setup output";
}

function resolveCommandLog(
  command: SetupCommand,
  autoExpandIndex: number | null,
  log: string,
): string {
  if ("log" in command && typeof command.log === "string") {
    return command.log;
  }
  if (command.index === autoExpandIndex) return log;
  return "";
}

interface BuildCommandRowPropsArgs {
  command: SetupCommand;
  autoExpandIndex: number | null;
  log: string;
  expandedIndices: Set<number>;
  manuallyCollapsed: Set<number>;
  snapshotError: string | null | undefined;
}

function buildCommandRowState(args: BuildCommandRowPropsArgs) {
  const { command, autoExpandIndex, log, expandedIndices, manuallyCollapsed, snapshotError } = args;
  const isExpanded = expandedIndices.has(command.index);
  const hasError = command.status === "failed" && Boolean(snapshotError);
  const commandLog = resolveCommandLog(command, autoExpandIndex, log);
  const hasLog = commandLog.trim().length > 0;
  const isExpandable = command.status !== "running" || hasLog || hasError;
  const isAutoExpanded = command.index === autoExpandIndex && !manuallyCollapsed.has(command.index);
  const showDetail = isExpanded || isAutoExpanded;
  const processedLog = hasLog ? processCarriageReturns(commandLog) : "";
  return { hasError, hasLog, isExpandable, isAutoExpanded, showDetail, processedLog };
}

function SetupPanel() {
  const { theme } = useUnistyles();
  const { serverId, target } = usePaneContext();
  invariant(target.kind === "setup", "SetupPanel requires setup target");

  const client = useHostRuntimeClient(serverId);
  const key = buildWorkspaceTabPersistenceKey({
    serverId,
    workspaceId: target.workspaceId,
  });
  const snapshot = useWorkspaceSetupStore((state) => (key ? (state.snapshots[key] ?? null) : null));
  const upsertProgress = useWorkspaceSetupStore((state) => state.upsertProgress);

  // On mount, if no snapshot in the store, request cached status from server
  const requestedRef = useRef(false);
  useEffect(() => {
    if (snapshot || requestedRef.current || !client) return;
    requestedRef.current = true;
    client
      .fetchWorkspaceSetupStatus(target.workspaceId)
      .then((response) => {
        if (response.snapshot) {
          upsertProgress({
            serverId,
            payload: { workspaceId: response.workspaceId, ...response.snapshot },
          });
        }
        return;
      })
      .catch(() => {
        // Server may not support this yet — ignore
      });
  }, [client, snapshot, serverId, target.workspaceId, upsertProgress]);

  const commands = snapshot?.detail.commands ?? [];
  const log = snapshot?.detail.log ?? "";
  const hasNoSetupCommands =
    snapshot?.status === "completed" && commands.length === 0 && log.trim().length === 0;
  const isWaiting = !snapshot || (snapshot.status === "running" && commands.length === 0);

  const [expandedIndices, setExpandedIndices] = useState<Set<number>>(new Set());
  const [manuallyCollapsed, setManuallyCollapsed] = useState<Set<number>>(new Set());

  const toggleExpanded = useCallback((index: number, isAutoExpanded: boolean) => {
    setExpandedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index) || isAutoExpanded) {
        next.delete(index);
        // If this was auto-expanded, record that the user manually collapsed it
        if (isAutoExpanded) {
          setManuallyCollapsed((mc) => new Set(mc).add(index));
        }
      } else {
        next.add(index);
        // If the user re-expands, remove from manually collapsed
        setManuallyCollapsed((mc) => {
          const updated = new Set(mc);
          updated.delete(index);
          return updated;
        });
      }
      return next;
    });
  }, []);

  const autoExpandIndex = resolveAutoExpandIndex(commands);
  const statusLabel = resolveSetupStatusLabel(snapshot?.status);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
      testID="workspace-setup-panel"
    >
      {/* Hidden element for status — preserves testID for E2E */}
      <Text style={styles.hiddenStatus} testID="workspace-setup-status">
        {statusLabel}
      </Text>

      {isWaiting ? (
        <View style={styles.waitingContainer}>
          <ActivityIndicator size="large" color={theme.colors.foregroundMuted} />
          <Text style={styles.waitingText}>Setting up workspace...</Text>
        </View>
      ) : null}
      {!isWaiting && hasNoSetupCommands ? (
        <View style={styles.emptyContainer}>
          <Text
            style={styles.emptyText}
            accessible
            accessibilityLabel="No setup commands ran for this workspace"
          >
            No setup commands ran for this workspace.
          </Text>
        </View>
      ) : null}
      {!isWaiting && !hasNoSetupCommands ? (
        <View style={styles.commandList}>
          {commands.map((command) => {
            const rowState = buildCommandRowState({
              command,
              autoExpandIndex,
              log,
              expandedIndices,
              manuallyCollapsed,
              snapshotError: snapshot?.error,
            });

            return (
              <SetupCommandRow
                key={`${command.index}:${command.command}`}
                command={command}
                showDetail={rowState.showDetail}
                isAutoExpanded={rowState.isAutoExpanded}
                isExpandable={rowState.isExpandable}
                hasLog={rowState.hasLog}
                hasError={rowState.hasError}
                processedLog={rowState.processedLog}
                errorMessage={snapshot?.error ?? null}
                foregroundMutedColor={theme.colors.foregroundMuted}
                onToggle={toggleExpanded}
              />
            );
          })}

          <StandaloneLogView commands={commands} log={log} />
          <TopLevelSetupError snapshotError={snapshot?.error ?? null} commands={commands} />
        </View>
      ) : null}
    </ScrollView>
  );
}

interface SetupCommandRowProps {
  command: SetupCommand;
  showDetail: boolean;
  isAutoExpanded: boolean;
  isExpandable: boolean;
  hasLog: boolean;
  hasError: boolean;
  processedLog: string;
  errorMessage: string | null;
  foregroundMutedColor: string;
  onToggle: (index: number, isAutoExpanded: boolean) => void;
}

function SetupCommandRow({
  command,
  showDetail,
  isAutoExpanded,
  isExpandable,
  hasLog,
  hasError,
  processedLog,
  errorMessage,
  foregroundMutedColor,
  onToggle,
}: SetupCommandRowProps) {
  const handlePress = useCallback(() => {
    if (!isExpandable) return;
    onToggle(command.index, isAutoExpanded);
  }, [command.index, isAutoExpanded, isExpandable, onToggle]);

  const pressableStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.commandRow,
      showDetail && styles.commandRowExpanded,
      pressed && styles.commandRowPressed,
    ],
    [showDetail],
  );

  const accessibilityState = useMemo(() => ({ expanded: showDetail }), [showDetail]);

  return (
    <View style={styles.commandItem}>
      <Pressable
        onPress={handlePress}
        style={pressableStyle}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
      >
        <View style={styles.commandStatusIcon}>
          <CommandStatusIcon status={command.status} />
        </View>
        <Text style={styles.commandText} numberOfLines={1}>
          {command.command}
        </Text>
        {command.durationMs != null ? (
          <Text style={styles.commandDuration}>{formatDuration(command.durationMs)}</Text>
        ) : null}
        <SetupCommandChevron showDetail={showDetail} color={foregroundMutedColor} />
      </Pressable>
      {showDetail ? (
        <View style={styles.commandDetail}>
          {hasLog ? (
            <ScrollView
              style={styles.logScroll}
              contentContainerStyle={styles.logScrollContent}
              horizontal={false}
              showsVerticalScrollIndicator
              testID="workspace-setup-log"
              accessible
              accessibilityLabel="Workspace setup log"
            >
              <Text selectable style={styles.logText}>
                {processedLog}
              </Text>
            </ScrollView>
          ) : (
            <View
              style={styles.logScrollContent}
              testID="workspace-setup-log"
              accessible
              accessibilityLabel="Workspace setup log"
            >
              <Text style={styles.emptyLogText}>No output</Text>
            </View>
          )}
          {hasError && errorMessage ? (
            <View style={styles.errorCard}>
              <Text selectable style={styles.errorText}>
                {errorMessage}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export const setupPanelRegistration: PanelRegistration<"setup"> = {
  kind: "setup",
  component: SetupPanel,
  useDescriptor: useSetupPanelDescriptor,
};

function SetupCommandChevron({ showDetail, color }: { showDetail: boolean; color: string }) {
  const chevronStyle = useMemo(
    () => [styles.chevron, showDetail && styles.chevronExpanded],
    [showDetail],
  );
  return <ChevronRight size={14} color={color} style={chevronStyle} />;
}

function StandaloneLogView({ commands, log }: { commands: SetupCommand[]; log: string }) {
  if (commands.length !== 0 || log.trim().length === 0) return null;
  return (
    <ScrollView
      style={styles.logScroll}
      contentContainerStyle={styles.logScrollContent}
      showsVerticalScrollIndicator
      testID="workspace-setup-log"
      accessible
      accessibilityLabel="Workspace setup log"
    >
      <Text selectable style={styles.logText}>
        {log}
      </Text>
    </ScrollView>
  );
}

function TopLevelSetupError({
  snapshotError,
  commands,
}: {
  snapshotError: string | null;
  commands: SetupCommand[];
}) {
  if (!snapshotError) return null;
  if (commands.some((c) => c.status === "failed")) return null;
  return (
    <View style={styles.errorCard}>
      <Text selectable style={styles.errorText}>
        {snapshotError}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  contentContainer: {
    padding: theme.spacing[4],
    flexGrow: 1,
  },
  hiddenStatus: {
    position: "absolute",
    width: 1,
    height: 1,
    overflow: "hidden",
    opacity: 0,
  },
  waitingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
  },
  waitingText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  commandList: {
    gap: theme.spacing[2],
  },
  commandItem: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  commandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  commandRowExpanded: {
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  commandRowPressed: {
    opacity: 0.8,
  },
  commandStatusIcon: {
    width: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  commandText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  commandDuration: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  chevron: {
    flexShrink: 0,
  },
  chevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
  commandDetail: {
    backgroundColor: theme.colors.surface0,
  },
  logScroll: {
    maxHeight: 400,
  },
  logScrollContent: {
    padding: theme.spacing[3],
  },
  logText: {
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foreground,
  },
  emptyLogText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
  errorCard: {
    padding: theme.spacing[3],
    backgroundColor: theme.colors.palette.red[100],
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.red[800],
  },
}));
