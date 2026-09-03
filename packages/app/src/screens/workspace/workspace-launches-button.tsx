import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, Globe, Play, Square, SquareTerminal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeSnapshot, type ActiveConnection } from "@/runtime/host-runtime";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/contexts/toast-context";
import { openServiceUrl } from "@/utils/open-service-url";
import {
  resolveWorkspaceLaunchEndpointLink,
  type WorkspaceScriptLinkKind,
  type WorkspaceScriptLinkTarget,
} from "@/utils/workspace-script-links";
import { useWorkspaceServiceRoutePreferencesStore } from "@/workspace-service-routes/store";
import type { Theme } from "@/styles/theme";

type WorkspaceLaunches = NonNullable<WorkspaceDescriptor["launches"]>;
type LaunchActionIcon = "open" | "start" | "stop" | "terminal";
export type WorkspaceLaunchAction = "start" | "stop";

export interface WorkspaceLaunchError {
  action: WorkspaceLaunchAction;
  message: string;
}

export interface WorkspaceLaunchesSectionProps {
  serverId: string;
  workspaceId: string;
  launches: WorkspaceLaunches;
  launchErrors: Readonly<Record<string, WorkspaceLaunchError | undefined>>;
  liveTerminalIds?: readonly string[];
  onLaunchError: (launchName: string, error: WorkspaceLaunchError) => void;
  onClearLaunchError: (launchName: string) => void;
  onLaunchTerminalStarted?: (terminalId: string) => void;
  onViewTerminal?: (terminalId: string) => void;
  onOpenUrlInBrowserTab?: (url: string) => void;
}

const ThemedGlobe = withUnistyles(Globe);
const ThemedPlay = withUnistyles(Play);
const ThemedSquare = withUnistyles(Square);
const ThemedSquareTerminal = withUnistyles(SquareTerminal);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedChevronDown = withUnistyles(ChevronDown);

const playFillTransparent = { fill: "transparent" };
const pendingAccessibilityState = { busy: true, disabled: true };

const foregroundColorMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});
const mutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const blueColorMapping = (theme: Theme) => ({
  color: theme.colors.palette.blue[500],
});

function LaunchActionIconElement({
  hovered,
  icon,
}: {
  hovered?: boolean;
  icon: LaunchActionIcon;
}): ReactElement {
  const colorMapping = hovered ? foregroundColorMapping : mutedColorMapping;
  switch (icon) {
    case "open":
      return <ThemedGlobe size={12} uniProps={colorMapping} />;
    case "start":
      return <ThemedPlay size={11} uniProps={colorMapping} {...playFillTransparent} />;
    case "stop":
      return <ThemedSquare size={11} uniProps={colorMapping} />;
    case "terminal":
      return <ThemedSquareTerminal size={12} uniProps={colorMapping} />;
  }
}

function LaunchActionButton({
  accessibilityLabel,
  disabled,
  icon,
  label,
  onPress,
  pending,
  testID,
  tooltipLabel,
}: {
  accessibilityLabel: string;
  disabled?: boolean;
  icon?: LaunchActionIcon;
  label?: string;
  onPress: () => void;
  pending?: boolean;
  testID: string;
  tooltipLabel: string;
}): ReactElement {
  return (
    <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild triggerRefProp="ref">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          testID={testID}
          hitSlop={6}
          disabled={disabled}
          accessibilityState={pending ? pendingAccessibilityState : undefined}
          onPress={onPress}
          style={label ? styles.labeledActionButton : styles.iconActionButton}
        >
          {({ hovered }) => {
            let actionIcon: ReactElement | null = null;
            if (pending) {
              actionIcon = (
                <View testID={`${testID}-pending`} accessibilityRole="progressbar">
                  <ThemedLoadingSpinner size={12} uniProps={mutedColorMapping} />
                </View>
              );
            } else if (icon) {
              actionIcon = <LaunchActionIconElement hovered={hovered} icon={icon} />;
            }

            return (
              <>
                {actionIcon}
                {label ? <Text style={styles.actionLabel}>{label}</Text> : null}
              </>
            );
          }}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent testID={`${testID}-tooltip`} side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltipLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function routeLabelKey(
  kind: WorkspaceScriptLinkKind,
):
  | "workspace.scripts.routes.public"
  | "workspace.scripts.routes.paseo"
  | "workspace.scripts.routes.direct" {
  switch (kind) {
    case "public":
      return "workspace.scripts.routes.public";
    case "paseo":
      return "workspace.scripts.routes.paseo";
    case "direct":
      return "workspace.scripts.routes.direct";
  }
}

function LaunchEndpointRouteOption({
  endpoint,
  selectedKind,
  target,
  onSelect,
}: {
  endpoint: WorkspaceLaunches[number]["endpoints"][number];
  selectedKind: WorkspaceScriptLinkKind;
  target: WorkspaceScriptLinkTarget;
  onSelect: (kind: WorkspaceScriptLinkKind) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onSelect(target.kind), [onSelect, target.kind]);
  return (
    <DropdownMenuItem
      testID={`workspace-launches-route-${endpoint.id}-${target.kind}`}
      selected={target.kind === selectedKind}
      showSelectedCheck
      description={target.label}
      onSelect={handleSelect}
    >
      {t(routeLabelKey(target.kind))}
    </DropdownMenuItem>
  );
}

function LaunchEndpointRouteSelector({
  endpoint,
  selectedTarget,
  targets,
  onSelect,
}: {
  endpoint: WorkspaceLaunches[number]["endpoints"][number];
  selectedTarget: WorkspaceScriptLinkTarget;
  targets: WorkspaceScriptLinkTarget[];
  onSelect: (kind: WorkspaceScriptLinkKind) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <View collapsable={false} style={styles.endpointRouteSelectorFrame}>
        <DropdownMenuTrigger
          accessibilityRole="button"
          accessibilityLabel={t("workspace.scripts.accessibility.chooseUrl", {
            scriptName: endpoint.hostname,
          })}
          testID={`workspace-launches-route-${endpoint.id}`}
          hitSlop={6}
          style={styles.endpointRouteTrigger}
        >
          {({ hovered }) => (
            <>
              <ThemedChevronDown
                size={14}
                uniProps={hovered ? foregroundColorMapping : mutedColorMapping}
                style={styles.endpointRouteChevron}
              />
              <Text
                style={
                  hovered ? [styles.endpointName, styles.endpointNameActive] : styles.endpointName
                }
                numberOfLines={1}
              >
                {selectedTarget.label}
              </Text>
            </>
          )}
        </DropdownMenuTrigger>
      </View>
      <DropdownMenuContent side="bottom" align="end" minWidth={220} maxWidth={280}>
        {targets.map((target) => (
          <LaunchEndpointRouteOption
            key={target.kind}
            endpoint={endpoint}
            selectedKind={selectedTarget.kind}
            target={target}
            onSelect={onSelect}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LaunchEndpointRow({
  activeConnection,
  endpoint,
  launchName,
  preferredRouteKind,
  onSelectRouteKind,
  onOpenUrlInBrowserTab,
}: {
  activeConnection: ActiveConnection | null;
  endpoint: WorkspaceLaunches[number]["endpoints"][number];
  launchName: string;
  preferredRouteKind: WorkspaceScriptLinkKind | null;
  onSelectRouteKind: (kind: WorkspaceScriptLinkKind) => void;
  onOpenUrlInBrowserTab?: (url: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  // COMPAT(workspaceLaunchTcpListeners): added in v0.7.0, remove after 2027-02-28 once the
  // supported daemon floor is >= v0.7.0. Older daemons omit the protocol for HTTP endpoints.
  const protocol = endpoint.protocol ?? "http";
  const endpointLink = resolveWorkspaceLaunchEndpointLink({ endpoint, activeConnection });
  const selectedTarget =
    endpointLink.targets.find((target) => target.kind === preferredRouteKind) ??
    endpointLink.primary;
  const handleOpen = useCallback(() => {
    if (selectedTarget) {
      void openServiceUrl(selectedTarget.url, { openInApp: onOpenUrlInBrowserTab });
    }
  }, [onOpenUrlInBrowserTab, selectedTarget]);

  return (
    <View style={styles.endpointRow}>
      <Text style={styles.endpointPort}>{endpoint.port}</Text>
      {selectedTarget && endpointLink.targets.length > 1 ? (
        <LaunchEndpointRouteSelector
          endpoint={endpoint}
          selectedTarget={selectedTarget}
          targets={endpointLink.targets}
          onSelect={onSelectRouteKind}
        />
      ) : (
        <Text style={styles.endpointName} numberOfLines={1}>
          {selectedTarget?.label ?? (protocol === "tcp" ? "TCP" : endpoint.hostname)}
        </Text>
      )}
      {selectedTarget ? (
        <LaunchActionButton
          accessibilityLabel={t("workspace.launches.accessibility.openService", {
            hostname: endpoint.hostname,
          })}
          testID={`workspace-launches-open-${launchName}-${endpoint.id}`}
          icon="open"
          onPress={handleOpen}
          tooltipLabel={t("workspace.launches.actions.openService")}
        />
      ) : null}
    </View>
  );
}

interface LaunchRowProps {
  launch: WorkspaceLaunches[number];
  liveTerminalIdSet: Set<string>;
  activeConnection: ActiveConnection | null;
  pendingStartLaunchName: string | null;
  pendingStopLaunchName: string | null;
  launchError: WorkspaceLaunchError | null;
  onStart: (launchName: string) => void;
  onStop: (launchName: string) => void;
  onClearLaunchError: (launchName: string) => void;
  preferredRouteKind: WorkspaceScriptLinkKind | null;
  onSelectRouteKind: (kind: WorkspaceScriptLinkKind) => void;
  onViewTerminal?: (terminalId: string) => void;
  onOpenUrlInBrowserTab?: (url: string) => void;
}

function LaunchRow({
  launch,
  liveTerminalIdSet,
  activeConnection,
  pendingStartLaunchName,
  pendingStopLaunchName,
  launchError,
  onStart,
  onStop,
  onClearLaunchError,
  preferredRouteKind,
  onSelectRouteKind,
  onViewTerminal,
  onOpenUrlInBrowserTab,
}: LaunchRowProps): ReactElement {
  const { t } = useTranslation();
  const isRunning = launch.lifecycle === "running";
  const isStartPending = pendingStartLaunchName === launch.launchName;
  const isStopPending = pendingStopLaunchName === launch.launchName;
  const hasPendingLifecycleAction =
    pendingStartLaunchName !== null || pendingStopLaunchName !== null;
  const liveTerminalId =
    launch.terminalId && liveTerminalIdSet.has(launch.terminalId) ? launch.terminalId : null;
  const handleStart = useCallback(() => onStart(launch.launchName), [launch.launchName, onStart]);
  const handleStop = useCallback(() => onStop(launch.launchName), [launch.launchName, onStop]);
  const handleRetry = useCallback(() => {
    if (launchError?.action === "start") {
      onStart(launch.launchName);
    } else if (launchError?.action === "stop") {
      onStop(launch.launchName);
    }
  }, [launch.launchName, launchError?.action, onStart, onStop]);
  const handleDismissError = useCallback(
    () => onClearLaunchError(launch.launchName),
    [launch.launchName, onClearLaunchError],
  );
  const handleViewTerminal = useCallback(() => {
    if (liveTerminalId) onViewTerminal?.(liveTerminalId);
  }, [liveTerminalId, onViewTerminal]);

  return (
    <View
      testID={`workspace-launches-item-${launch.launchName}`}
      accessibilityLabel={t("workspace.launches.accessibility.launch", {
        launchName: launch.launchName,
      })}
    >
      <View style={styles.launchHeader}>
        <ThemedPlay
          size={14}
          uniProps={isRunning ? blueColorMapping : mutedColorMapping}
          {...playFillTransparent}
        />
        <View style={styles.launchLabel}>
          <Text
            style={isRunning ? [styles.launchName, styles.launchNameActive] : styles.launchName}
            numberOfLines={1}
          >
            {launch.launchName}
          </Text>
        </View>
        <View style={styles.spacer} />
        {liveTerminalId ? (
          <LaunchActionButton
            accessibilityLabel={t("workspace.launches.accessibility.viewTerminal", {
              launchName: launch.launchName,
            })}
            testID={`workspace-launches-view-${launch.launchName}`}
            icon="terminal"
            label={t("workspace.launches.actions.view")}
            onPress={handleViewTerminal}
            tooltipLabel={t("workspace.launches.actions.view")}
          />
        ) : null}
        {isRunning ? (
          <LaunchActionButton
            accessibilityLabel={t("workspace.launches.accessibility.stopLaunch", {
              launchName: launch.launchName,
            })}
            testID={`workspace-launches-stop-${launch.launchName}`}
            disabled={hasPendingLifecycleAction}
            icon="stop"
            onPress={handleStop}
            pending={isStopPending}
            tooltipLabel={t("workspace.launches.actions.stop")}
          />
        ) : (
          <LaunchActionButton
            accessibilityLabel={t("workspace.launches.accessibility.startLaunch", {
              launchName: launch.launchName,
            })}
            testID={`workspace-launches-start-${launch.launchName}`}
            disabled={hasPendingLifecycleAction}
            icon="start"
            onPress={handleStart}
            pending={isStartPending}
            tooltipLabel={t("workspace.launches.actions.start")}
          />
        )}
      </View>
      {launchError ? (
        <View
          testID={`workspace-launches-error-${launch.launchName}`}
          style={styles.launchError}
          accessibilityRole="alert"
        >
          <Text style={styles.launchErrorText}>{launchError.message}</Text>
          <View style={styles.launchErrorActions}>
            <LaunchActionButton
              accessibilityLabel={t("common.actions.retry")}
              disabled={hasPendingLifecycleAction}
              label={t("common.actions.retry")}
              onPress={handleRetry}
              testID={`workspace-launches-retry-${launch.launchName}`}
              tooltipLabel={t("common.actions.retry")}
            />
            <LaunchActionButton
              accessibilityLabel={t("common.actions.dismiss")}
              label={t("common.actions.dismiss")}
              onPress={handleDismissError}
              testID={`workspace-launches-dismiss-error-${launch.launchName}`}
              tooltipLabel={t("common.actions.dismiss")}
            />
          </View>
        </View>
      ) : null}
      {isRunning && launch.endpoints.length > 0 ? (
        <View style={styles.endpointList}>
          {launch.endpoints.map((endpoint) => (
            <LaunchEndpointRow
              key={endpoint.id}
              activeConnection={activeConnection}
              endpoint={endpoint}
              launchName={launch.launchName}
              preferredRouteKind={preferredRouteKind}
              onSelectRouteKind={onSelectRouteKind}
              onOpenUrlInBrowserTab={onOpenUrlInBrowserTab}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function WorkspaceLaunchesSection({
  serverId,
  workspaceId,
  launches,
  launchErrors,
  liveTerminalIds = [],
  onLaunchError,
  onClearLaunchError,
  onLaunchTerminalStarted,
  onViewTerminal,
  onOpenUrlInBrowserTab,
}: WorkspaceLaunchesSectionProps): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const activeConnection = useHostRuntimeSnapshot(serverId)?.activeConnection ?? null;
  const preferredRouteKind = useWorkspaceServiceRoutePreferencesStore(
    (state) => state.byServerId[serverId] ?? null,
  );
  const setPreferredRoute = useWorkspaceServiceRoutePreferencesStore(
    (state) => state.setPreferredRoute,
  );
  const liveTerminalIdSet = useMemo(() => new Set(liveTerminalIds), [liveTerminalIds]);
  const portRangeLaunch =
    launches.find(
      (launch) => launch.active && launch.portBase !== null && launch.portEnd !== null,
    ) ?? launches.find((launch) => launch.portBase !== null && launch.portEnd !== null);
  const portRange =
    portRangeLaunch && portRangeLaunch.portBase !== null && portRangeLaunch.portEnd !== null
      ? t("workspace.launches.states.portRange", {
          base: portRangeLaunch.portBase,
          end: portRangeLaunch.portEnd,
        })
      : null;

  const startMutation = useMutation({
    mutationFn: async (launchName: string) => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const result = await client.startWorkspaceLaunch(workspaceId, launchName);
      if (result.error || !result.launch) {
        throw new Error(result.error ?? t("workspace.launches.states.startFailed", { launchName }));
      }
      return result;
    },
    onMutate: (launchName) => onClearLaunchError(launchName),
    onError: (error, launchName) => {
      const message =
        error instanceof Error
          ? error.message
          : t("workspace.launches.states.startFailed", { launchName });
      onLaunchError(launchName, { action: "start", message });
      toast.show(message, { variant: "error" });
    },
    onSuccess: (result, launchName) => {
      onClearLaunchError(launchName);
      if (result.launch?.terminalId) {
        onLaunchTerminalStarted?.(result.launch.terminalId);
      }
    },
  });
  const stopMutation = useMutation({
    mutationFn: async (launchName: string) => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const result = await client.stopWorkspaceLaunch(workspaceId, launchName);
      if (result.error) {
        throw new Error(result.error);
      }
      return result;
    },
    onMutate: (launchName) => onClearLaunchError(launchName),
    onError: (error, launchName) => {
      const message =
        error instanceof Error
          ? error.message
          : t("workspace.launches.states.stopFailed", { launchName });
      onLaunchError(launchName, { action: "stop", message });
      toast.show(message, { variant: "error" });
    },
    onSuccess: (_result, launchName) => onClearLaunchError(launchName),
  });
  const pendingStartLaunchName = startMutation.isPending ? (startMutation.variables ?? null) : null;
  const pendingStopLaunchName = stopMutation.isPending ? (stopMutation.variables ?? null) : null;

  const handleStart = useCallback(
    (launchName: string) => startMutation.mutate(launchName),
    [startMutation],
  );
  const handleStop = useCallback(
    (launchName: string) => stopMutation.mutate(launchName),
    [stopMutation],
  );
  const handleSelectRouteKind = useCallback(
    (kind: WorkspaceScriptLinkKind) => setPreferredRoute(serverId, kind),
    [serverId, setPreferredRoute],
  );

  if (launches.length === 0) {
    return null;
  }

  return (
    <View testID="workspace-launches-section">
      <DropdownMenuLabel>{t("workspace.launches.title")}</DropdownMenuLabel>
      {portRange ? (
        <View style={styles.portRangeHeader}>
          <Text testID="workspace-launches-port-range" style={styles.portRangeText}>
            {portRange}
          </Text>
        </View>
      ) : null}
      {launches.map((launch) => (
        <LaunchRow
          key={launch.launchName}
          launch={launch}
          liveTerminalIdSet={liveTerminalIdSet}
          activeConnection={activeConnection}
          pendingStartLaunchName={pendingStartLaunchName}
          pendingStopLaunchName={pendingStopLaunchName}
          launchError={launchErrors[launch.launchName] ?? null}
          onStart={handleStart}
          onStop={handleStop}
          onClearLaunchError={onClearLaunchError}
          preferredRouteKind={preferredRouteKind}
          onSelectRouteKind={handleSelectRouteKind}
          onViewTerminal={onViewTerminal}
          onOpenUrlInBrowserTab={onOpenUrlInBrowserTab}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  launchHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    minHeight: 36,
  },
  launchLabel: {
    flexShrink: 1,
    minWidth: 0,
    gap: 1,
  },
  launchName: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    lineHeight: 18,
    color: theme.colors.foregroundMuted,
  },
  launchNameActive: {
    color: theme.colors.foreground,
  },
  launchError: {
    gap: theme.spacing[2],
    marginHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[2],
  },
  launchErrorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    lineHeight: 14,
  },
  launchErrorActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  portRangeHeader: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  portRangeText: {
    fontSize: theme.fontSize.sm,
    lineHeight: 14,
    color: theme.colors.foregroundMuted,
  },
  spacer: {
    flex: 1,
    minWidth: 0,
  },
  iconActionButton: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.sm,
  },
  labeledActionButton: {
    height: 22,
    paddingHorizontal: theme.spacing[1],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  actionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 14,
  },
  endpointList: {
    marginTop: -theme.spacing[1],
    marginBottom: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    gap: 2,
  },
  endpointRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: 22,
  },
  endpointPort: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 14,
  },
  endpointName: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 14,
  },
  endpointNameActive: {
    color: theme.colors.foreground,
  },
  endpointRouteSelectorFrame: {
    flex: 1,
    minWidth: 0,
  },
  endpointRouteTrigger: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  endpointRouteChevron: {
    flexShrink: 0,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
