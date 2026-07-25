import { Fragment, useCallback, useEffect, useMemo, useRef, type ReactElement } from "react";
import type { GestureResponderEvent } from "react-native";
import { Pressable, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useMutation } from "@tanstack/react-query";
import {
  ChevronDown,
  Copy,
  Eye,
  Globe,
  Play,
  RotateCw,
  Square,
  SquareTerminal,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  useDropdownMenuClose,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/contexts/toast-context";
import { openServiceUrl } from "@/utils/open-service-url";
import {
  resolveWorkspaceScriptLink,
  type WorkspaceScriptLinkKind,
  type WorkspaceScriptLinkTarget,
} from "@/utils/workspace-script-links";
import type { Theme } from "@/styles/theme";
import { useWorkspaceServiceRoutePreferencesStore } from "@/workspace-service-routes/store";

type RowActionIcon = "copy" | "open" | "restart" | "start" | "stop" | "terminal";

interface WorkspaceScriptsButtonProps {
  serverId: string;
  workspaceId: string;
  scripts: WorkspaceDescriptor["scripts"];
  liveTerminalIds?: readonly string[];
  onScriptTerminalStarted?: (terminalId: string) => void;
  onViewTerminal?: (terminalId: string) => void;
  onOpenUrlInBrowserTab?: (url: string) => void;
  hideLabels?: boolean;
  presentation?: "split" | "ghost";
}

const ThemedPlay = withUnistyles(Play);
const ThemedSquareTerminal = withUnistyles(SquareTerminal);
const ThemedGlobe = withUnistyles(Globe);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedEye = withUnistyles(Eye);
const ThemedCopy = withUnistyles(Copy);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedSquare = withUnistyles(Square);

const GHOST_TRIGGER_ICON_SIZE = 16;

const foregroundColorMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});
const mutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const blueColorMapping = (theme: Theme) => ({
  color: theme.colors.palette.blue[500],
});
const greenColorMapping = (theme: Theme) => ({
  color: theme.colors.palette.green[500],
});
const redColorMapping = (theme: Theme) => ({
  color: theme.colors.palette.red[500],
});
const playFillTransparent = { fill: "transparent" };
const ghostPlayStroke = { strokeWidth: 1.5 };

interface ScriptRowActionButtonProps {
  accessibilityLabel: string;
  disabled?: boolean;
  icon: RowActionIcon;
  onPress: () => void;
  testID: string;
  tooltipLabel: string;
}

function RowActionIconElement({
  hovered,
  icon,
}: {
  hovered?: boolean;
  icon: RowActionIcon;
}): ReactElement {
  const colorMapping = hovered ? foregroundColorMapping : mutedColorMapping;
  switch (icon) {
    case "copy":
      return <ThemedCopy size={11} uniProps={colorMapping} />;
    case "open":
      return <ThemedEye size={12} uniProps={colorMapping} />;
    case "restart":
      return <ThemedRotateCw size={11} uniProps={colorMapping} />;
    case "start":
      return <ThemedPlay size={11} uniProps={colorMapping} {...playFillTransparent} />;
    case "stop":
      return <ThemedSquare size={11} uniProps={colorMapping} />;
    case "terminal":
      return <ThemedSquareTerminal size={12} uniProps={colorMapping} />;
  }
}

function ScriptRowActionButton({
  accessibilityLabel,
  disabled,
  icon,
  onPress,
  testID,
  tooltipLabel,
}: ScriptRowActionButtonProps): ReactElement {
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onPress();
    },
    [onPress],
  );

  const renderChildren = useCallback(
    ({ hovered }: { hovered?: boolean }) => <RowActionIconElement hovered={hovered} icon={icon} />,
    [icon],
  );

  return (
    <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild triggerRefProp="ref">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          testID={testID}
          hitSlop={6}
          disabled={disabled}
          onPress={handlePress}
          style={styles.iconActionButton}
        >
          {renderChildren}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent testID={`${testID}-tooltip`} side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltipLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

interface ServiceLinkRowProps {
  selectedTarget: WorkspaceScriptLinkTarget;
  targets: WorkspaceScriptLinkTarget[];
  scriptName: string;
  onSelectKind: (kind: WorkspaceScriptLinkKind) => void;
  onCopy: (url: string, label: string) => void;
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

function ServiceRouteOption({
  scriptName,
  selectedKind,
  target,
  onSelect,
}: {
  scriptName: string;
  selectedKind: WorkspaceScriptLinkKind;
  target: WorkspaceScriptLinkTarget;
  onSelect: (kind: WorkspaceScriptLinkKind) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onSelect(target.kind), [onSelect, target.kind]);
  return (
    <DropdownMenuItem
      testID={`workspace-scripts-route-${scriptName}-${target.kind}`}
      selected={target.kind === selectedKind}
      showSelectedCheck
      description={target.label}
      onSelect={handleSelect}
    >
      {t(routeLabelKey(target.kind))}
    </DropdownMenuItem>
  );
}

function ServiceRouteTriggerContent({
  hovered,
  label,
}: {
  hovered: boolean;
  label: string;
}): ReactElement {
  return (
    <>
      <View style={styles.routeSelectorButton}>
        <ThemedChevronDown
          size={14}
          uniProps={hovered ? foregroundColorMapping : mutedColorMapping}
        />
      </View>
      <Text
        style={hovered ? [styles.hostLabel, styles.hostLabelActive] : styles.hostLabel}
        numberOfLines={1}
      >
        {label}
      </Text>
    </>
  );
}

function ServiceRouteSelector({
  scriptName,
  selectedTarget,
  targets,
  onSelect,
}: {
  scriptName: string;
  selectedTarget: WorkspaceScriptLinkTarget;
  targets: WorkspaceScriptLinkTarget[];
  onSelect: (kind: WorkspaceScriptLinkKind) => void;
}): ReactElement {
  const { t } = useTranslation();
  const accessibilityLabel = t("workspace.scripts.accessibility.chooseUrl", { scriptName });

  return (
    <DropdownMenu>
      <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild triggerRefProp="ref">
          <View collapsable={false} style={styles.routeSelectorFrame}>
            <DropdownMenuTrigger
              accessibilityRole="button"
              accessibilityLabel={accessibilityLabel}
              testID={`workspace-scripts-route-${scriptName}`}
              hitSlop={6}
              style={styles.routeSelectorTrigger}
            >
              {({ hovered }) => (
                <ServiceRouteTriggerContent hovered={hovered} label={selectedTarget.label} />
              )}
            </DropdownMenuTrigger>
          </View>
        </TooltipTrigger>
        <TooltipContent
          testID={`workspace-scripts-route-${scriptName}-tooltip`}
          side="top"
          align="center"
          offset={8}
        >
          <Text style={styles.tooltipText}>{t("workspace.scripts.actions.chooseUrl")}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="bottom" align="end" minWidth={220} maxWidth={280}>
        {targets.map((target) => (
          <ServiceRouteOption
            key={target.kind}
            scriptName={scriptName}
            selectedKind={selectedTarget.kind}
            target={target}
            onSelect={onSelect}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ServiceLinkRow({
  selectedTarget,
  targets,
  scriptName,
  onSelectKind,
  onCopy,
}: ServiceLinkRowProps): ReactElement {
  const { t } = useTranslation();
  const closeMenu = useDropdownMenuClose();
  const { label, url } = selectedTarget;

  const handleCopy = useCallback(() => {
    closeMenu();
    onCopy(url, label);
  }, [url, label, onCopy, closeMenu]);

  return (
    <View style={styles.hostRow}>
      {targets.length > 1 ? (
        <ServiceRouteSelector
          scriptName={scriptName}
          selectedTarget={selectedTarget}
          targets={targets}
          onSelect={onSelectKind}
        />
      ) : (
        <View style={styles.routeDisplay}>
          <View style={styles.routeSelectorButton} />
          <Text style={styles.hostLabel} numberOfLines={1}>
            {label}
          </Text>
        </View>
      )}
      <ScriptRowActionButton
        accessibilityLabel={t("workspace.scripts.accessibility.copyUrl", { scriptName })}
        testID={`workspace-scripts-copy-${scriptName}`}
        icon="copy"
        onPress={handleCopy}
        tooltipLabel={t("workspace.scripts.actions.copyUrl")}
      />
    </View>
  );
}

function ExitCodeBadge({ code }: { code: number }): ReactElement {
  const { t } = useTranslation();
  const exitTextStyle =
    code === 0 ? styles.exitBadgeText : [styles.exitBadgeText, styles.exitBadgeTextError];
  return (
    <View style={styles.exitBadge}>
      <Text style={exitTextStyle}>{t("workspace.scripts.states.exitCode", { code })}</Text>
    </View>
  );
}

interface ScriptRowProps {
  script: WorkspaceDescriptor["scripts"][number];
  liveTerminalIdSet: Set<string>;
  activeConnection: ReturnType<typeof useHostRuntimeSnapshot> extends infer R
    ? R extends { activeConnection: infer A }
      ? A
      : null
    : null;
  isStartPending: boolean;
  isStopPending: boolean;
  onStartScript: (scriptName: string) => void;
  onStopScript: (scriptName: string) => void;
  onRestartScript: (scriptName: string) => void;
  onCopyUrl: (url: string, label: string) => void;
  preferredRouteKind: WorkspaceScriptLinkKind | null;
  onSelectRouteKind: (kind: WorkspaceScriptLinkKind) => void;
  onViewTerminal?: (terminalId: string) => void;
  onOpenUrlInBrowserTab?: (url: string) => void;
}

function resolveScriptIconColorMapping(args: {
  script: WorkspaceDescriptor["scripts"][number];
  isService: boolean;
  isRunning: boolean;
}): (theme: Theme) => { color: string } {
  const { script, isService, isRunning } = args;
  if (isService) {
    if (isRunning && script.health === "healthy") return greenColorMapping;
    if (isRunning && script.health === "unhealthy") return redColorMapping;
    if (isRunning) return blueColorMapping;
    return mutedColorMapping;
  }
  if (isRunning) return blueColorMapping;
  return mutedColorMapping;
}

function ScriptRow({
  script,
  liveTerminalIdSet,
  activeConnection,
  isStartPending,
  isStopPending,
  onStartScript,
  onStopScript,
  onRestartScript,
  onCopyUrl,
  preferredRouteKind,
  onSelectRouteKind,
  onViewTerminal,
  onOpenUrlInBrowserTab,
}: ScriptRowProps): ReactElement {
  const { t } = useTranslation();
  const isRunning = script.lifecycle === "running";
  const isService = (script.type ?? "service") === "service";
  const exitCode = script.exitCode ?? null;
  const serviceLink = resolveWorkspaceScriptLink({ script, activeConnection });
  const selectedLink =
    isService && isRunning
      ? (serviceLink.targets.find((target) => target.kind === preferredRouteKind) ??
        serviceLink.primary)
      : null;
  const liveTerminalId =
    script.terminalId && liveTerminalIdSet.has(script.terminalId) ? script.terminalId : null;

  const iconColorMapping = resolveScriptIconColorMapping({ script, isService, isRunning });
  const ScriptIcon = isService ? ThemedGlobe : ThemedSquareTerminal;
  const showExitBadge = !isRunning && exitCode !== null;
  const closeMenu = useDropdownMenuClose();

  const handleOpenService = useCallback(() => {
    if (!selectedLink) return;
    closeMenu();
    void openServiceUrl(selectedLink.url, { openInApp: onOpenUrlInBrowserTab });
  }, [selectedLink, closeMenu, onOpenUrlInBrowserTab]);

  const handleView = useCallback(() => {
    if (liveTerminalId) onViewTerminal?.(liveTerminalId);
  }, [liveTerminalId, onViewTerminal]);

  const handleRun = useCallback(() => {
    onStartScript(script.scriptName);
  }, [onStartScript, script.scriptName]);

  const handleStop = useCallback(() => {
    onStopScript(script.scriptName);
  }, [onStopScript, script.scriptName]);

  const handleRestart = useCallback(() => {
    onRestartScript(script.scriptName);
  }, [onRestartScript, script.scriptName]);

  const scriptNameStyle = useMemo(
    () => (isRunning ? [styles.scriptName, styles.scriptNameActive] : styles.scriptName),
    [isRunning],
  );

  const viewAction =
    isRunning && liveTerminalId ? (
      <ScriptRowActionButton
        accessibilityLabel={t("workspace.scripts.accessibility.viewTerminal", {
          scriptName: script.scriptName,
        })}
        testID={`workspace-scripts-view-${script.scriptName}`}
        icon="terminal"
        onPress={handleView}
        tooltipLabel={t("workspace.scripts.actions.view")}
      />
    ) : null;

  const openServiceAction = selectedLink ? (
    <ScriptRowActionButton
      accessibilityLabel={t("workspace.scripts.accessibility.openService", {
        scriptName: script.scriptName,
      })}
      testID={`workspace-scripts-open-${script.scriptName}`}
      icon="open"
      onPress={handleOpenService}
      tooltipLabel={t("workspace.scripts.actions.openService")}
    />
  ) : null;

  const lifecycleAction = isRunning ? (
    <ScriptRowActionButton
      accessibilityLabel={t("workspace.scripts.accessibility.stopScript", {
        scriptName: script.scriptName,
      })}
      testID={`workspace-scripts-stop-${script.scriptName}`}
      disabled={isStopPending}
      icon="stop"
      onPress={handleStop}
      tooltipLabel={t("workspace.scripts.actions.stop")}
    />
  ) : (
    <ScriptRowActionButton
      accessibilityLabel={t("workspace.scripts.accessibility.runScript", {
        scriptName: script.scriptName,
      })}
      testID={`workspace-scripts-start-${script.scriptName}`}
      disabled={isStartPending}
      icon="start"
      onPress={handleRun}
      tooltipLabel={t("workspace.scripts.actions.run")}
    />
  );

  return (
    <View
      testID={`workspace-scripts-item-${script.scriptName}`}
      accessibilityLabel={t("workspace.scripts.accessibility.script", {
        scriptName: script.scriptName,
      })}
      style={styles.scriptItem}
    >
      <View style={styles.scriptHeader}>
        <ScriptIcon size={14} uniProps={iconColorMapping} style={styles.scriptIcon} />
        <Text style={scriptNameStyle} numberOfLines={1}>
          {script.scriptName}
        </Text>
        {showExitBadge ? <ExitCodeBadge code={exitCode} /> : null}
        <View style={styles.spacer} />
        {openServiceAction}
        {viewAction}
        {isRunning ? (
          <ScriptRowActionButton
            accessibilityLabel={t("workspace.scripts.accessibility.restartScript", {
              scriptName: script.scriptName,
            })}
            testID={`workspace-scripts-restart-${script.scriptName}`}
            disabled={isStopPending}
            icon="restart"
            onPress={handleRestart}
            tooltipLabel={t("workspace.scripts.actions.restart")}
          />
        ) : null}
        {lifecycleAction}
      </View>
      {selectedLink ? (
        <View style={styles.hostList}>
          <ServiceLinkRow
            selectedTarget={selectedLink}
            targets={serviceLink.targets}
            scriptName={script.scriptName}
            onSelectKind={onSelectRouteKind}
            onCopy={onCopyUrl}
          />
        </View>
      ) : null}
    </View>
  );
}

export function WorkspaceScriptsButton({
  serverId,
  workspaceId,
  scripts,
  liveTerminalIds = [],
  onScriptTerminalStarted,
  onViewTerminal,
  onOpenUrlInBrowserTab,
  hideLabels,
  presentation = "split",
}: WorkspaceScriptsButtonProps): ReactElement | null {
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
  const pendingRestartRef = useRef<Set<string>>(new Set());

  const startScriptMutation = useMutation({
    mutationFn: async (scriptName: string) => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const result = await client.startWorkspaceScript(workspaceId, scriptName);
      if (result.error) {
        throw new Error(result.error);
      }
      return result;
    },
    onError: (error, scriptName) => {
      toast.show(
        error instanceof Error
          ? error.message
          : t("workspace.scripts.states.startFailed", { scriptName }),
        {
          variant: "error",
        },
      );
    },
    onSuccess: (result) => {
      if (result.terminalId) {
        onScriptTerminalStarted?.(result.terminalId);
      }
    },
  });
  const startScript = startScriptMutation.mutate;

  const stopScriptMutation = useMutation({
    mutationFn: async (scriptName: string) => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const terminalId = scripts.find((s) => s.scriptName === scriptName)?.terminalId;
      if (!terminalId) {
        throw new Error(t("workspace.scripts.states.stopFailed", { scriptName }));
      }
      const result = await client.killTerminal(terminalId);
      if (!result.success) {
        throw new Error(t("workspace.scripts.states.stopFailed", { scriptName }));
      }
    },
    onError: (error, scriptName) => {
      pendingRestartRef.current.delete(scriptName);
      toast.show(
        error instanceof Error
          ? error.message
          : t("workspace.scripts.states.stopFailed", { scriptName }),
        {
          variant: "error",
        },
      );
    },
  });

  // Restart = kill the script terminal, then start again once the daemon
  // reports the script as stopped (it tears the runtime entry down on exit).
  useEffect(() => {
    const pending = pendingRestartRef.current;
    if (pending.size === 0) return;
    for (const script of scripts) {
      if (!pending.has(script.scriptName) || script.lifecycle === "running") continue;
      pending.delete(script.scriptName);
      startScript(script.scriptName);
    }
  }, [scripts, startScript]);

  const triggerStyle = useCallback(
    ({ hovered, pressed, open }: { hovered: boolean; pressed: boolean; open: boolean }) => [
      presentation === "ghost" ? styles.ghostButton : styles.splitButtonPrimary,
      (hovered || pressed || open) &&
        (presentation === "ghost" ? styles.ghostButtonHovered : styles.splitButtonPrimaryHovered),
    ],
    [presentation],
  );

  const handleStartScript = useCallback(
    (scriptName: string) => startScriptMutation.mutate(scriptName),
    [startScriptMutation],
  );

  const handleStopScript = useCallback(
    (scriptName: string) => stopScriptMutation.mutate(scriptName),
    [stopScriptMutation],
  );

  const handleRestartScript = useCallback(
    (scriptName: string) => {
      pendingRestartRef.current.add(scriptName);
      stopScriptMutation.mutate(scriptName);
    },
    [stopScriptMutation],
  );

  const handleCopyUrl = useCallback(
    (url: string, label: string) => {
      void Clipboard.setStringAsync(url);
      toast.copied(label);
    },
    [toast],
  );

  const handleSelectRouteKind = useCallback(
    (kind: WorkspaceScriptLinkKind) => setPreferredRoute(serverId, kind),
    [serverId, setPreferredRoute],
  );

  if (scripts.length === 0) {
    return null;
  }

  const hasAnyRunning = scripts.some((s) => s.lifecycle === "running");
  const triggerPlayMapping = hasAnyRunning ? blueColorMapping : mutedColorMapping;
  const triggerIconSize = presentation === "ghost" ? GHOST_TRIGGER_ICON_SIZE : 14;
  const triggerPlayProps =
    presentation === "ghost" ? { ...playFillTransparent, ...ghostPlayStroke } : playFillTransparent;

  return (
    <View style={styles.row}>
      <View style={presentation === "ghost" ? styles.ghostButtonFrame : styles.splitButton}>
        <DropdownMenu>
          <DropdownMenuTrigger
            testID="workspace-scripts-button"
            style={triggerStyle}
            accessibilityRole="button"
            accessibilityLabel={t("workspace.scripts.accessibility.trigger")}
          >
            <View style={styles.splitButtonContent}>
              <ThemedPlay
                size={triggerIconSize}
                uniProps={triggerPlayMapping}
                {...triggerPlayProps}
              />
              {!hideLabels && (
                <Text style={styles.splitButtonText}>{t("workspace.scripts.title")}</Text>
              )}
              {presentation === "split" ? (
                <ThemedChevronDown size={14} uniProps={mutedColorMapping} />
              ) : null}
            </View>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            minWidth={200}
            maxWidth={280}
            testID="workspace-scripts-menu"
          >
            <View style={styles.scriptList}>
              {scripts.map((script, index) => (
                <Fragment key={script.scriptName}>
                  {index > 0 ? <DropdownMenuSeparator /> : null}
                  <ScriptRow
                    script={script}
                    liveTerminalIdSet={liveTerminalIdSet}
                    activeConnection={activeConnection}
                    isStartPending={startScriptMutation.isPending}
                    isStopPending={stopScriptMutation.isPending}
                    onStartScript={handleStartScript}
                    onStopScript={handleStopScript}
                    onRestartScript={handleRestartScript}
                    onCopyUrl={handleCopyUrl}
                    preferredRouteKind={preferredRouteKind}
                    onSelectRouteKind={handleSelectRouteKind}
                    onViewTerminal={onViewTerminal}
                    onOpenUrlInBrowserTab={onOpenUrlInBrowserTab}
                  />
                </Fragment>
              ))}
            </View>
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
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    justifyContent: "center",
  },
  splitButtonPrimaryHovered: {
    backgroundColor: theme.colors.surface2,
  },
  splitButtonText: {
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.normal,
  },
  splitButtonContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1.5],
    minHeight: theme.fontSize.sm * 1.5,
  },
  scriptList: {
    paddingVertical: theme.spacing[1],
  },
  scriptItem: {
    paddingVertical: 6,
  },
  scriptHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    minHeight: 24,
  },
  scriptIcon: {
    flexShrink: 0,
  },
  scriptName: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    lineHeight: 18,
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
  },
  scriptNameActive: {
    color: theme.colors.foreground,
  },
  spacer: {
    flex: 1,
    minWidth: 0,
  },
  hostList: {
    marginTop: 2,
    paddingHorizontal: theme.spacing[3],
  },
  hostRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: 2,
    minHeight: 18,
  },
  routeDisplay: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  hostLabel: {
    flexShrink: 1,
    fontSize: theme.fontSize.xs,
    lineHeight: 14,
    color: theme.colors.foregroundMuted,
  },
  hostLabelActive: {
    color: theme.colors.foreground,
  },
  exitBadge: {
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 1,
    borderRadius: 2,
    backgroundColor: theme.colors.surface2,
  },
  exitBadgeText: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  exitBadgeTextError: {
    color: theme.colors.palette.red[300],
  },
  iconActionButton: {
    padding: 2,
  },
  routeSelectorButton: {
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  routeSelectorFrame: {
    flex: 1,
    minWidth: 0,
  },
  routeSelectorTrigger: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
}));
