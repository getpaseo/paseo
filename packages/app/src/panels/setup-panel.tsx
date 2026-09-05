import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ChevronRight, CircleAlert, SquareTerminal } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Pressable, type PressableStateCallbackType, ScrollView, Text, View } from "react-native";
import invariant from "tiny-invariant";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelDescriptor } from "@/panels/panel-registry";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import type { Theme } from "@/styles/theme";
import {
  useWorkspaceSetupStore,
  type WorkspaceSetupSnapshot,
} from "@/stores/workspace-setup-store";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";

function useSetupPanelDescriptor(
  target: { kind: "setup"; workspaceId: string },
  context: { serverId: string; workspaceId: string },
): PanelDescriptor {
  const { t } = useTranslation();
  const key = buildWorkspaceTabPersistenceKey({
    serverId: context.serverId,
    workspaceId: target.workspaceId,
  });
  const snapshot = useWorkspaceSetupStore((state) => (key ? (state.snapshots[key] ?? null) : null));

  if (snapshot?.status === "completed") {
    return {
      label: t("workspace.setup.descriptor.label"),
      subtitle: t("workspace.setup.descriptor.completed"),
      tooltip: t("workspace.setup.descriptor.completed"),
      titleState: "ready",
      icon: CheckCircle2,
      statusBucket: null,
    };
  }

  if (snapshot?.status === "failed") {
    return {
      label: t("workspace.setup.descriptor.label"),
      subtitle: t("workspace.setup.descriptor.failed"),
      tooltip: t("workspace.setup.descriptor.failed"),
      titleState: "ready",
      icon: CircleAlert,
      statusBucket: null,
    };
  }

  if (snapshot?.status === "blocked") {
    return {
      label: t("workspace.setup.descriptor.label"),
      subtitle: t("workspace.setup.descriptor.blocked"),
      tooltip: t("workspace.setup.descriptor.blocked"),
      titleState: "ready",
      icon: CircleAlert,
      statusBucket: null,
    };
  }

  return {
    label: t("workspace.setup.descriptor.label"),
    subtitle: t("workspace.setup.descriptor.workspace"),
    tooltip: t("workspace.setup.descriptor.workspace"),
    titleState: "ready",
    icon: SquareTerminal,
    statusBucket: snapshot?.status === "running" ? "running" : null,
  };
}

type CommandStatus = "running" | "completed" | "failed";

function CommandStatusIcon({ status }: { status: CommandStatus }) {
  if (status === "running") {
    return <ThemedLoadingSpinner size={14} uniProps={foregroundColorMapping} />;
  }
  if (status === "completed") {
    return <ThemedCheckCircle2 size={14} uniProps={greenColorMapping} />;
  }
  return <ThemedCircleAlert size={14} uniProps={redColorMapping} />;
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

const EMPTY_COMMANDS: SetupCommand[] = [];

function BlockedSetupNotice({
  serverId,
  workspaceId,
  source,
}: {
  serverId: string;
  workspaceId: string;
  source: NonNullable<WorkspaceSetupSnapshot["blockedSource"]>;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const supportsSetupRun = useHostFeature(serverId, "workspaceSetupRun");
  const [runError, setRunError] = useState<string | null>(null);
  const [isRunningSetup, setIsRunningSetup] = useState(false);
  const runSetup = useCallback(async () => {
    if (!client) return;
    setRunError(null);
    setIsRunningSetup(true);
    try {
      const response = await client.runWorkspaceSetup(workspaceId);
      if (response.error) throw new Error(response.error);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : t("workspace.setup.blocked.runFailed"));
    } finally {
      setIsRunningSetup(false);
    }
  }, [client, t, workspaceId]);

  return (
    <>
      <Alert
        variant="warning"
        title={t("workspace.setup.blocked.title")}
        description={t("workspace.setup.blocked.description", {
          repository: source.headRepository,
        })}
        testID="workspace-setup-blocked"
      >
        {supportsSetupRun ? (
          <Button accessibilityRole="button" onPress={runSetup} loading={isRunningSetup} size="sm">
            {t("workspace.setup.blocked.run")}
          </Button>
        ) : null}
      </Alert>
      {runError ? <Alert variant="error" description={runError} /> : null}
    </>
  );
}

function resolveAutoExpandIndex(commands: { index: number; status: string }[]): number | null {
  const running = commands.find((c) => c.status === "running");
  if (running) return running.index;
  if (commands.length > 0) return commands[commands.length - 1].index;
  return null;
}

function resolveSetupStatusLabel(
  status: string | undefined,
  labels: Record<CommandStatus | "blocked" | "waiting", string>,
): string {
  if (status === "running") return labels.running;
  if (status === "completed") return labels.completed;
  if (status === "failed") return labels.failed;
  if (status === "blocked") return labels.blocked;
  return labels.waiting;
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

function useWorkspaceSetupSnapshot(serverId: string, workspaceId: string) {
  const client = useHostRuntimeClient(serverId);
  const key = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const snapshot = useWorkspaceSetupStore((state) => (key ? (state.snapshots[key] ?? null) : null));
  const upsertProgress = useWorkspaceSetupStore((state) => state.upsertProgress);
  const requestedRef = useRef(false);

  useEffect(() => {
    if (snapshot || requestedRef.current || !client) return;
    requestedRef.current = true;
    client
      .fetchWorkspaceSetupStatus(workspaceId)
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
        // Server may not support this yet — ignore.
      });
  }, [client, snapshot, serverId, upsertProgress, workspaceId]);

  return snapshot;
}

function useExpandedSetupCommands() {
  const [expandedIndices, setExpandedIndices] = useState<Set<number>>(new Set());
  const [manuallyCollapsed, setManuallyCollapsed] = useState<Set<number>>(new Set());
  const toggleExpanded = useCallback((index: number, isAutoExpanded: boolean) => {
    setExpandedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index) || isAutoExpanded) {
        next.delete(index);
        if (isAutoExpanded) setManuallyCollapsed((current) => new Set(current).add(index));
      } else {
        next.add(index);
        setManuallyCollapsed((current) => {
          const updated = new Set(current);
          updated.delete(index);
          return updated;
        });
      }
      return next;
    });
  }, []);
  return { expandedIndices, manuallyCollapsed, toggleExpanded };
}

function SetupPanel() {
  const { t } = useTranslation();
  const { serverId, target } = usePaneContext();
  invariant(target.kind === "setup", "SetupPanel requires setup target");

  const snapshot = useWorkspaceSetupSnapshot(serverId, target.workspaceId);

  const commands = snapshot?.detail.commands ?? EMPTY_COMMANDS;
  const log = snapshot?.detail.log ?? "";
  const hasNoSetupCommands =
    snapshot?.status === "completed" && commands.length === 0 && log.trim().length === 0;
  const isWaiting = !snapshot || (snapshot.status === "running" && commands.length === 0);

  const { expandedIndices, manuallyCollapsed, toggleExpanded } = useExpandedSetupCommands();

  const autoExpandIndex = resolveAutoExpandIndex(commands);
  const statusLabels = useMemo(
    () => ({
      running: t("workspace.setup.status.running"),
      completed: t("workspace.setup.status.completed"),
      failed: t("workspace.setup.status.failed"),
      blocked: t("workspace.setup.status.blocked"),
      waiting: t("workspace.setup.status.waiting"),
    }),
    [t],
  );
  const statusLabel = resolveSetupStatusLabel(snapshot?.status, statusLabels);

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
      <SetupPanelBody
        serverId={serverId}
        workspaceId={target.workspaceId}
        snapshot={snapshot}
        commands={commands}
        log={log}
        isWaiting={isWaiting}
        hasNoSetupCommands={hasNoSetupCommands}
        autoExpandIndex={autoExpandIndex}
        expandedIndices={expandedIndices}
        manuallyCollapsed={manuallyCollapsed}
        onToggle={toggleExpanded}
      />
    </ScrollView>
  );
}

interface SetupPanelBodyProps {
  serverId: string;
  workspaceId: string;
  snapshot: WorkspaceSetupSnapshot | null;
  commands: SetupCommand[];
  log: string;
  isWaiting: boolean;
  hasNoSetupCommands: boolean;
  autoExpandIndex: number | null;
  expandedIndices: Set<number>;
  manuallyCollapsed: Set<number>;
  onToggle: (index: number, isAutoExpanded: boolean) => void;
}

function SetupPanelBody(props: SetupPanelBodyProps) {
  const { t } = useTranslation();
  const { snapshot, commands, log } = props;
  if (snapshot?.status === "blocked" && snapshot.blockedSource) {
    return (
      <BlockedSetupNotice
        serverId={props.serverId}
        workspaceId={props.workspaceId}
        source={snapshot.blockedSource}
      />
    );
  }
  if (props.isWaiting) {
    return (
      <View style={styles.waitingContainer}>
        <ThemedLoadingSpinner size="large" uniProps={foregroundMutedColorMapping} />
        <Text style={styles.waitingText}>{t("workspace.setup.waiting")}</Text>
      </View>
    );
  }
  if (props.hasNoSetupCommands) {
    return (
      <View style={styles.emptyContainer}>
        <Text
          style={styles.emptyText}
          accessible
          accessibilityLabel={t("workspace.setup.accessibility.noCommands")}
        >
          {t("workspace.setup.empty.noCommands")}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.commandList}>
      {commands.map((command) => {
        const rowState = buildCommandRowState({
          command,
          autoExpandIndex: props.autoExpandIndex,
          log,
          expandedIndices: props.expandedIndices,
          manuallyCollapsed: props.manuallyCollapsed,
          snapshotError: snapshot?.error,
        });
        return (
          <SetupCommandRow
            key={`${command.index}:${command.command}`}
            command={command}
            {...rowState}
            errorMessage={snapshot?.error ?? null}
            onToggle={props.onToggle}
          />
        );
      })}
      <StandaloneLogView commands={commands} log={log} />
      <TopLevelSetupError snapshotError={snapshot?.error ?? null} commands={commands} />
    </View>
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
  onToggle,
}: SetupCommandRowProps) {
  const { t } = useTranslation();
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
        <SetupCommandChevron showDetail={showDetail} />
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
              accessibilityLabel={t("workspace.setup.accessibility.log")}
            >
              <Text selectable dataSet={CODE_SURFACE_DATASET} style={styles.logText}>
                {processedLog}
              </Text>
            </ScrollView>
          ) : (
            <View
              style={styles.logScrollContent}
              testID="workspace-setup-log"
              accessible
              accessibilityLabel={t("workspace.setup.accessibility.log")}
            >
              <Text style={styles.emptyLogText}>{t("workspace.setup.log.noOutput")}</Text>
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

export const setupPanelRegistration = definePanel("setup", {
  component: SetupPanel,
  useDescriptor: useSetupPanelDescriptor,
});

function SetupCommandChevron({ showDetail }: { showDetail: boolean }) {
  const chevronStyle = useMemo(
    () => [styles.chevron, showDetail && styles.chevronExpanded],
    [showDetail],
  );
  return (
    <ThemedChevronRight size={14} uniProps={foregroundMutedColorMapping} style={chevronStyle} />
  );
}

function StandaloneLogView({ commands, log }: { commands: SetupCommand[]; log: string }) {
  const { t } = useTranslation();
  if (commands.length !== 0 || log.trim().length === 0) return null;
  return (
    <ScrollView
      style={styles.logScroll}
      contentContainerStyle={styles.logScrollContent}
      showsVerticalScrollIndicator
      testID="workspace-setup-log"
      accessible
      accessibilityLabel={t("workspace.setup.accessibility.log")}
    >
      <Text selectable dataSet={CODE_SURFACE_DATASET} style={styles.logText}>
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

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedCheckCircle2 = withUnistyles(CheckCircle2);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedChevronRight = withUnistyles(ChevronRight);

const foregroundColorMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const greenColorMapping = (theme: Theme) => ({
  color: theme.colors.palette.green[500],
});
const redColorMapping = (theme: Theme) => ({
  color: theme.colors.palette.red[500],
});

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
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    fontSize: theme.fontSize.base,
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
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  commandDuration: {
    fontSize: theme.fontSize.sm,
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
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: 20,
    color: theme.colors.foreground,
  },
  emptyLogText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
  errorCard: {
    padding: theme.spacing[3],
    backgroundColor: theme.colors.palette.red[100],
  },
  errorText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.palette.red[800],
  },
}));
