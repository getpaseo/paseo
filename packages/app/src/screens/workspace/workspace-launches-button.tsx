import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, Globe, Play, Square, SquareTerminal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/contexts/toast-context";
import { openServiceUrl } from "@/utils/open-service-url";
import type { Theme } from "@/styles/theme";
import { buttonControlHeight, HEADER_CONTROL_HEIGHT } from "@/components/ui/control-geometry";
import { extraMutedIconColorMapping } from "@/components/ui/icon-color";

type WorkspaceLaunches = NonNullable<WorkspaceDescriptor["launches"]>;
type LaunchActionIcon = "open" | "start" | "stop" | "terminal";

interface WorkspaceLaunchesButtonProps {
  serverId: string;
  workspaceId: string;
  launches: WorkspaceLaunches;
  liveTerminalIds?: readonly string[];
  onLaunchTerminalStarted?: (terminalId: string) => void;
  onViewTerminal?: (terminalId: string) => void;
  onOpenUrlInBrowserTab?: (url: string) => void;
  hideLabels?: boolean;
  presentation?: "split" | "ghost";
}

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedGlobe = withUnistyles(Globe);
const ThemedPlay = withUnistyles(Play);
const ThemedSquare = withUnistyles(Square);
const ThemedSquareTerminal = withUnistyles(SquareTerminal);

const GHOST_TRIGGER_ICON_SIZE = 16;
const playFillTransparent = { fill: "transparent" };
const ghostPlayStroke = { strokeWidth: 1.5 };

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
  testID,
  tooltipLabel,
}: {
  accessibilityLabel: string;
  disabled?: boolean;
  icon: LaunchActionIcon;
  label?: string;
  onPress: () => void;
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
          onPress={onPress}
          style={label ? styles.labeledActionButton : styles.iconActionButton}
        >
          {({ hovered }) => (
            <>
              <LaunchActionIconElement hovered={hovered} icon={icon} />
              {label ? <Text style={styles.actionLabel}>{label}</Text> : null}
            </>
          )}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent testID={`${testID}-tooltip`} side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltipLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function endpointUrl(endpoint: WorkspaceLaunches[number]["endpoints"][number]): string | null {
  return endpoint.publicProxyUrl ?? endpoint.localProxyUrl ?? endpoint.proxyUrl ?? null;
}

function LaunchEndpointRow({
  endpoint,
  launchName,
  onOpenUrlInBrowserTab,
}: {
  endpoint: WorkspaceLaunches[number]["endpoints"][number];
  launchName: string;
  onOpenUrlInBrowserTab?: (url: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const url = endpointUrl(endpoint);
  const handleOpen = useCallback(() => {
    if (url) void openServiceUrl(url, { openInApp: onOpenUrlInBrowserTab });
  }, [onOpenUrlInBrowserTab, url]);

  return (
    <View style={styles.endpointRow}>
      <Text style={styles.endpointPort}>{endpoint.port}</Text>
      <Text style={styles.endpointName} numberOfLines={1}>
        {endpoint.hostname}
      </Text>
      {url ? (
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
  isStartPending: boolean;
  isStopPending: boolean;
  onStart: (launchName: string) => void;
  onStop: (launchName: string) => void;
  onViewTerminal?: (terminalId: string) => void;
  onOpenUrlInBrowserTab?: (url: string) => void;
}

function LaunchRow({
  launch,
  liveTerminalIdSet,
  isStartPending,
  isStopPending,
  onStart,
  onStop,
  onViewTerminal,
  onOpenUrlInBrowserTab,
}: LaunchRowProps): ReactElement {
  const { t } = useTranslation();
  const isRunning = launch.lifecycle === "running";
  const liveTerminalId =
    launch.terminalId && liveTerminalIdSet.has(launch.terminalId) ? launch.terminalId : null;
  const portRange =
    launch.portBase !== null && launch.portEnd !== null
      ? t("workspace.launches.states.portRange", { base: launch.portBase, end: launch.portEnd })
      : null;
  const handleStart = useCallback(() => onStart(launch.launchName), [launch.launchName, onStart]);
  const handleStop = useCallback(() => onStop(launch.launchName), [launch.launchName, onStop]);
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
          {portRange ? (
            <Text style={styles.launchHint} numberOfLines={1}>
              {portRange}
            </Text>
          ) : null}
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
            disabled={isStopPending}
            icon="stop"
            onPress={handleStop}
            tooltipLabel={t("workspace.launches.actions.stop")}
          />
        ) : (
          <LaunchActionButton
            accessibilityLabel={t("workspace.launches.accessibility.startLaunch", {
              launchName: launch.launchName,
            })}
            testID={`workspace-launches-start-${launch.launchName}`}
            disabled={isStartPending}
            icon="start"
            onPress={handleStart}
            tooltipLabel={t("workspace.launches.actions.start")}
          />
        )}
      </View>
      {isRunning && launch.endpoints.length > 0 ? (
        <View style={styles.endpointList}>
          {launch.endpoints.map((endpoint) => (
            <LaunchEndpointRow
              key={endpoint.id}
              endpoint={endpoint}
              launchName={launch.launchName}
              onOpenUrlInBrowserTab={onOpenUrlInBrowserTab}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function WorkspaceLaunchesButton({
  serverId,
  workspaceId,
  launches,
  liveTerminalIds = [],
  onLaunchTerminalStarted,
  onViewTerminal,
  onOpenUrlInBrowserTab,
  hideLabels,
  presentation = "split",
}: WorkspaceLaunchesButtonProps): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const liveTerminalIdSet = useMemo(() => new Set(liveTerminalIds), [liveTerminalIds]);

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
    onError: (error, launchName) => {
      toast.show(
        error instanceof Error
          ? error.message
          : t("workspace.launches.states.startFailed", { launchName }),
        { variant: "error" },
      );
    },
    onSuccess: (result) => {
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
    onError: (error, launchName) => {
      toast.show(
        error instanceof Error
          ? error.message
          : t("workspace.launches.states.stopFailed", { launchName }),
        { variant: "error" },
      );
    },
  });

  const triggerStyle = useCallback(
    ({ hovered, pressed, open }: { hovered: boolean; pressed: boolean; open: boolean }) => [
      presentation === "ghost" ? styles.ghostButton : styles.splitButtonPrimary,
      (hovered || pressed || open) &&
        (presentation === "ghost" ? styles.ghostButtonHovered : styles.splitButtonPrimaryHovered),
    ],
    [presentation],
  );
  const handleStart = useCallback(
    (launchName: string) => startMutation.mutate(launchName),
    [startMutation],
  );
  const handleStop = useCallback(
    (launchName: string) => stopMutation.mutate(launchName),
    [stopMutation],
  );

  if (launches.length === 0) {
    return null;
  }

  const hasActiveLaunch = launches.some((launch) => launch.active);
  const triggerIconSize = presentation === "ghost" ? GHOST_TRIGGER_ICON_SIZE : 14;
  const triggerPlayProps =
    presentation === "ghost" ? { ...playFillTransparent, ...ghostPlayStroke } : playFillTransparent;

  return (
    <View style={styles.row}>
      <View style={presentation === "ghost" ? styles.ghostButtonFrame : styles.splitButton}>
        <DropdownMenu>
          <DropdownMenuTrigger
            testID="workspace-launches-button"
            style={triggerStyle}
            accessibilityRole="button"
            accessibilityLabel={t("workspace.launches.accessibility.trigger")}
          >
            <View style={styles.splitButtonContent}>
              <ThemedPlay
                size={triggerIconSize}
                uniProps={hasActiveLaunch ? blueColorMapping : mutedColorMapping}
                {...triggerPlayProps}
              />
              {!hideLabels ? (
                <Text style={styles.splitButtonText}>{t("workspace.launches.title")}</Text>
              ) : null}
              {presentation === "split" ? (
                <ThemedChevronDown size={16} uniProps={extraMutedIconColorMapping} />
              ) : null}
            </View>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            minWidth={220}
            maxWidth={320}
            maxHeight={460}
            scrollable
            testID="workspace-launches-menu"
          >
            {launches.map((launch) => (
              <LaunchRow
                key={launch.launchName}
                launch={launch}
                liveTerminalIdSet={liveTerminalIdSet}
                isStartPending={startMutation.isPending}
                isStopPending={stopMutation.isPending}
                onStart={handleStart}
                onStop={handleStop}
                onViewTerminal={onViewTerminal}
                onOpenUrlInBrowserTab={onOpenUrlInBrowserTab}
              />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  splitButton: {
    height: {
      xs: buttonControlHeight.xs,
      md: HEADER_CONTROL_HEIGHT,
    },
    flexDirection: "row",
    alignItems: "stretch",
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    overflow: "hidden",
  },
  ghostButtonFrame: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  ghostButton: {
    width: theme.spacing[8],
    height: theme.spacing[8],
    padding: 0,
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  ghostButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  splitButtonPrimary: {
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[2],
    },
    justifyContent: "center",
  },
  splitButtonPrimaryHovered: {
    backgroundColor: theme.colors.surface2,
  },
  splitButtonText: {
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.5,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.normal,
  },
  splitButtonContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: {
      xs: theme.spacing[1.5],
      md: theme.spacing[1],
    },
    minHeight: theme.fontSize.base * 1.5,
  },
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
  launchHint: {
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
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
