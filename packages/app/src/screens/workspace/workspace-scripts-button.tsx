import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { GestureResponderEvent } from "react-native";
import { Pressable, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useMutation } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
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
import type {
  PaseoConfigRaw,
  PaseoConfigRevision,
  PaseoScriptEntryRaw,
  WorkspaceScriptPayload,
} from "@getpaseo/protocol/messages";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeSnapshot, type ActiveConnection } from "@/runtime/host-runtime";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  useDropdownMenuClose,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MENU_ITEM_HEIGHT } from "@/components/ui/menu/menu-geometry";
import { useToast } from "@/contexts/toast-context";
import { openServiceUrl } from "@/utils/open-service-url";
import {
  resolveWorkspaceScriptLink,
  type WorkspaceScriptLinkKind,
  type WorkspaceScriptLinkTarget,
} from "@/utils/workspace-script-links";
import type { Theme } from "@/styles/theme";
import { useWorkspaceServiceRoutePreferencesStore } from "@/workspace-service-routes/store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { buttonControlHeight, HEADER_CONTROL_HEIGHT } from "@/components/ui/control-geometry";
import { extraMutedIconColorMapping } from "@/components/ui/icon-color";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { validateWorkspaceScriptDraft } from "@/utils/workspace-script-form";
import type { WorkspaceScriptValidationError } from "@/utils/workspace-script-form";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { EditingTextInput as TextInput } from "@/components/ui/text-input";

type RowActionIcon = "copy" | "open" | "restart" | "start" | "stop" | "terminal";

/**
 * Desktop-only (Electron, non-compact) dev-preview wiring. The button starts the preferred
 * service, waits for its own `running` + `healthy` + resolved-URL report and asks the workspace
 * to open the preview column; Stop tears the service down and only then closes the preview.
 */
export interface WorkspaceScriptsPreviewActions {
  onOpenPreview: (input: { scriptName: string; url: string }) => void;
  onClosePreview: (scriptName: string) => void;
}

interface WorkspaceScriptsButtonProps {
  serverId: string;
  workspaceId: string;
  scripts: WorkspaceDescriptor["scripts"];
  liveTerminalIds?: readonly string[];
  onScriptTerminalStarted?: (terminalId: string) => void;
  onPreviewTerminalStarted?: (terminalId: string) => void;
  onPreviewPendingChange?: (pending: boolean) => void;
  onViewTerminal?: (terminalId: string) => void;
  onOpenUrlInBrowserTab?: (url: string) => void;
  hideLabels?: boolean;
  presentation?: "split" | "ghost";
  preview?: WorkspaceScriptsPreviewActions;
}

const ThemedPlay = withUnistyles(Play);
const ThemedSquareTerminal = withUnistyles(SquareTerminal);
const ThemedGlobe = withUnistyles(Globe);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedEye = withUnistyles(Eye);
const ThemedCopy = withUnistyles(Copy);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedSquare = withUnistyles(Square);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

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

function configurationWriteError(
  error: string,
  written: string,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (error === "stale_revision" || error === "invalid_config")
    return t("workspace.scripts.states.configurationConflict");
  if (error === "collision") return t("workspace.scripts.states.serviceNameCollision");
  if (written === "project") return t("workspace.scripts.states.partialConfigurationSave");
  return t("workspace.scripts.states.configurationSaveFailed");
}

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

type WorkspaceScriptsPreviewActionState = "choose" | "start" | "starting" | "stop";

function resolvePreviewActionState(input: {
  hasPreferredService: boolean;
  isServiceRunning: boolean;
  isWaitingForPreview: boolean;
  hasKnownTerminal: boolean;
}): WorkspaceScriptsPreviewActionState {
  if (!input.hasPreferredService) return "choose";
  if (input.isServiceRunning) return "stop";
  if (input.isWaitingForPreview) return input.hasKnownTerminal ? "stop" : "starting";
  return "start";
}

function resolvePreviewServiceUrl(input: {
  script: WorkspaceScriptPayload;
  preferredRouteKind: WorkspaceScriptLinkKind | null;
  activeConnection: ActiveConnection | null;
}): string | null {
  const serviceLink = resolveWorkspaceScriptLink({
    script: input.script,
    activeConnection: input.activeConnection,
  });
  const target =
    (input.preferredRouteKind
      ? serviceLink.targets.find((candidate) => candidate.kind === input.preferredRouteKind)
      : null) ?? serviceLink.primary;
  return target?.url ?? null;
}

type PreviewWaitDecision =
  | { kind: "wait" }
  | { kind: "cancel"; unhealthy: boolean }
  | { kind: "open"; url: string };

function resolvePreviewWaitDecision(input: {
  script: WorkspaceScriptPayload | undefined;
  preferredRouteKind: WorkspaceScriptLinkKind | null;
  activeConnection: ActiveConnection | null;
}): PreviewWaitDecision {
  const { script } = input;
  if (!script) {
    return { kind: "cancel", unhealthy: false };
  }
  if (script.lifecycle !== "running") {
    return { kind: "wait" };
  }
  if (script.health === "unhealthy") {
    return { kind: "cancel", unhealthy: true };
  }
  if (script.health !== "healthy") {
    return { kind: "wait" };
  }
  const url = resolvePreviewServiceUrl({
    script,
    preferredRouteKind: input.preferredRouteKind,
    activeConnection: input.activeConnection,
  });
  return url ? { kind: "open", url } : { kind: "wait" };
}

function applyPreviewWaitDecision(input: {
  decision: PreviewWaitDecision;
  scriptName: string;
  cancel: (scriptName: string) => void;
  open: (input: { scriptName: string; url: string }) => void;
  reportUnhealthy: (scriptName: string) => void;
}): void {
  if (input.decision.kind === "wait") {
    return;
  }
  input.cancel(input.scriptName);
  if (input.decision.kind === "open") {
    input.open({ scriptName: input.scriptName, url: input.decision.url });
    return;
  }
  if (input.decision.unhealthy) {
    input.reportUnhealthy(input.scriptName);
  }
}

function consumePendingRestarts(input: {
  pending: Set<string>;
  scripts: WorkspaceDescriptor["scripts"];
  startScript: (scriptName: string) => void;
}): void {
  if (input.pending.size === 0) {
    return;
  }
  for (const script of input.scripts) {
    if (!input.pending.has(script.scriptName) || script.lifecycle === "running") {
      continue;
    }
    input.pending.delete(script.scriptName);
    input.startScript(script.scriptName);
  }
}

function consumeScriptStartOutcome(input: {
  result: { terminalId?: string | null };
  scriptName: string;
  previewStartNames: Set<string>;
  onPreviewTerminal: (scriptName: string, terminalId: string) => void;
  onOrdinaryTerminal?: (terminalId: string) => void;
}): void {
  if (!input.result.terminalId) {
    return;
  }
  if (input.previewStartNames.delete(input.scriptName)) {
    input.onPreviewTerminal(input.scriptName, input.result.terminalId);
    return;
  }
  input.onOrdinaryTerminal?.(input.result.terminalId);
}

interface WorkspaceScriptsPreviewActionProps {
  hideLabels?: boolean;
  scriptName: string | null;
  isRunning: boolean;
  isWaiting: boolean;
  hasKnownTerminal: boolean;
  onChoose: () => void;
  onStart: (scriptName: string) => void;
  onStop: () => void;
}

/**
 * The direct-action segment of the desktop split button plus its chevron. Play starts the
 * preferred service, a running service shows Stop, and with no service chosen the first Play
 * opens the picker instead of guessing one.
 */
function WorkspaceScriptsPreviewAction({
  hideLabels,
  scriptName,
  isRunning,
  isWaiting,
  hasKnownTerminal,
  onChoose,
  onStart,
  onStop,
}: WorkspaceScriptsPreviewActionProps): ReactElement {
  const { t } = useTranslation();
  const state = resolvePreviewActionState({
    hasPreferredService: scriptName !== null,
    isServiceRunning: isRunning,
    isWaitingForPreview: isWaiting,
    hasKnownTerminal,
  });

  let accessibilityLabel: string;
  if (state === "choose") {
    accessibilityLabel = t("workspace.scripts.accessibility.choosePreviewService");
  } else if (state === "stop") {
    accessibilityLabel = t("workspace.scripts.accessibility.stopPreview", { scriptName });
  } else {
    accessibilityLabel = t("workspace.scripts.accessibility.startPreview", { scriptName });
  }

  let icon: ReactElement;
  if (state === "starting") {
    icon = <ThemedLoadingSpinner size={14} uniProps={blueColorMapping} />;
  } else if (state === "stop") {
    icon = <ThemedSquare size={14} uniProps={blueColorMapping} />;
  } else {
    icon = <ThemedPlay size={14} uniProps={mutedColorMapping} {...playFillTransparent} />;
  }

  const actionStyle = useCallback(
    ({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
      styles.splitButtonPrimary,
      (hovered || pressed) && styles.splitButtonPrimaryHovered,
    ],
    [],
  );
  const chevronStyle = useCallback(
    ({ hovered, pressed, open }: { hovered?: boolean; pressed: boolean; open: boolean }) => [
      styles.splitButtonSecondary,
      (hovered || pressed || open) && styles.splitButtonPrimaryHovered,
    ],
    [],
  );

  const handlePress = useCallback(() => {
    if (state === "stop") {
      onStop();
      return;
    }
    if (state === "start" && scriptName) {
      onStart(scriptName);
      return;
    }
    onChoose();
  }, [onChoose, onStart, onStop, scriptName, state]);

  return (
    <>
      <Pressable
        testID="workspace-scripts-preview-action"
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        disabled={state === "starting"}
        onPress={handlePress}
        style={actionStyle}
      >
        <View style={styles.splitButtonContent}>
          {icon}
          {!hideLabels && (
            <Text style={[styles.splitButtonText, state === "stop" && styles.runningText]}>
              {state === "stop"
                ? t("workspace.scripts.actions.stop")
                : t("workspace.scripts.actions.play")}
            </Text>
          )}
        </View>
      </Pressable>
      <DropdownMenuTrigger
        testID="workspace-scripts-button"
        style={chevronStyle}
        accessibilityRole="button"
        accessibilityLabel={t("workspace.scripts.accessibility.trigger")}
      >
        <View style={styles.splitButtonSecondaryContent}>
          <ThemedChevronDown size={16} uniProps={extraMutedIconColorMapping} />
        </View>
      </DropdownMenuTrigger>
    </>
  );
}

function PreviewServiceItem({
  scriptName,
  selected,
  onSelectService,
}: {
  scriptName: string;
  selected: boolean;
  onSelectService: (scriptName: string) => void;
}): ReactElement {
  const handleSelect = useCallback(
    () => onSelectService(scriptName),
    [onSelectService, scriptName],
  );
  return (
    <DropdownMenuItem
      testID={`workspace-scripts-preview-${scriptName}`}
      selected={selected}
      showSelectedCheck
      onSelect={handleSelect}
    >
      {scriptName}
    </DropdownMenuItem>
  );
}

function PreviewServiceMenuSection({
  services,
  preferredScriptName,
  onSelectService,
}: {
  services: WorkspaceDescriptor["scripts"];
  preferredScriptName: string | null;
  onSelectService: (scriptName: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      <DropdownMenuLabel testID="workspace-scripts-preview-section">
        {t("workspace.scripts.preview.section")}
      </DropdownMenuLabel>
      {services.map((service) => (
        <PreviewServiceItem
          key={service.scriptName}
          scriptName={service.scriptName}
          selected={service.scriptName === preferredScriptName}
          onSelectService={onSelectService}
        />
      ))}
      <DropdownMenuSeparator />
    </>
  );
}

type ToastApi = ReturnType<typeof useToast>;

async function requestStartWorkspaceScript(input: {
  client: DaemonClient | null;
  workspaceId: string;
  scriptName: string;
  clientUnavailableMessage: string;
}) {
  if (!input.client) {
    throw new Error(input.clientUnavailableMessage);
  }
  const result = await input.client.startWorkspaceScript(input.workspaceId, input.scriptName);
  if (result.error) {
    throw new Error(result.error);
  }
  return result;
}

async function requestStopWorkspaceScript(input: {
  client: DaemonClient | null;
  scripts: WorkspaceDescriptor["scripts"];
  scriptName: string;
  terminalId?: string | null;
  clientUnavailableMessage: string;
  stopFailedMessage: (scriptName: string) => string;
}) {
  if (!input.client) {
    throw new Error(input.clientUnavailableMessage);
  }
  const terminalId =
    input.terminalId ??
    input.scripts.find((s) => s.scriptName === input.scriptName)?.terminalId ??
    null;
  if (!terminalId) {
    throw new Error(input.stopFailedMessage(input.scriptName));
  }
  const result = await input.client.killTerminal(terminalId);
  if (!result.success) {
    throw new Error(input.stopFailedMessage(input.scriptName));
  }
}

function showScriptMutationError(input: {
  toast: ToastApi;
  error: unknown;
  fallbackMessage: string;
}): void {
  input.toast.show(input.error instanceof Error ? input.error.message : input.fallbackMessage, {
    variant: "error",
  });
}

function findStartablePreviewScript(input: {
  scripts: WorkspaceDescriptor["scripts"];
  scriptName: string;
}): WorkspaceScriptPayload | null {
  const script = input.scripts.find((candidate) => candidate.scriptName === input.scriptName);
  if (!script || script.lifecycle === "running") {
    return null;
  }
  return script;
}

function resolveKnownScriptTerminalId(input: {
  script: WorkspaceScriptPayload | null;
  trackedByScript: Record<string, string>;
  trackedFirst?: boolean;
}): string | null {
  if (!input.script) {
    return null;
  }
  const tracked = input.trackedByScript[input.script.scriptName] ?? null;
  if (input.trackedFirst) {
    // The terminal the start request returned is known before the payload syncs.
    return tracked ?? input.script.terminalId ?? null;
  }
  return input.script.terminalId ?? tracked ?? null;
}

interface UseWorkspaceScriptControlsInput {
  preview: WorkspaceScriptsPreviewActions | undefined;
  serverId: string;
  workspaceId: string;
  scripts: WorkspaceDescriptor["scripts"];
  client: DaemonClient | null;
  activeConnection: ActiveConnection | null;
  preferredRouteKind: WorkspaceScriptLinkKind | null;
  toast: ToastApi;
  onScriptTerminalStarted?: (terminalId: string) => void;
  onPreviewTerminalStarted?: (terminalId: string) => void;
  onPreviewPendingChange?: (pending: boolean) => void;
}

interface WorkspaceScriptControls {
  services: WorkspaceDescriptor["scripts"];
  previewEnabled: boolean;
  preferredService: WorkspaceScriptPayload | null;
  preferredScriptName: string | null;
  isWaitingForPreview: boolean;
  hasKnownTerminal: boolean;
  isStartPending: boolean;
  isStopPending: boolean;
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
  openMenu: () => void;
  startPreviewService: (scriptName: string) => void;
  stopPreviewService: () => void;
  selectPreviewService: (scriptName: string) => void;
  startScript: (scriptName: string) => void;
  stopScript: (scriptName: string) => void;
  restartScript: (scriptName: string) => void;
}

/**
 * Script lifecycle (start, stop, restart through the terminal) plus the desktop dev-preview
 * flow: the per-workspace service choice, the wait for `running` + `healthy` + a resolved URL,
 * and the cancellation rules that keep stale reports from opening a preview.
 */
function useWorkspaceScriptControls(
  input: UseWorkspaceScriptControlsInput,
): WorkspaceScriptControls {
  const {
    preview,
    serverId,
    workspaceId,
    scripts,
    client,
    activeConnection,
    onPreviewTerminalStarted,
    onPreviewPendingChange,
  } = input;
  const { t } = useTranslation();
  const toast = input.toast;
  const previewWorkspaceKey = useMemo(
    () => buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
    [serverId, workspaceId],
  );
  const preferredScriptByWorkspace = useWorkspaceServiceRoutePreferencesStore(
    (state) => state.preferredScriptByWorkspace,
  );
  const setPreferredScript = useWorkspaceServiceRoutePreferencesStore(
    (state) => state.setPreferredScript,
  );
  const services = useMemo(
    () => scripts.filter((script) => (script.type ?? "service") === "service"),
    [scripts],
  );
  const previewEnabled = preview !== undefined && services.length > 0;
  const previewKey = previewEnabled ? previewWorkspaceKey : null;
  const preferredService = useMemo(
    () =>
      previewKey
        ? (services.find(
            (script) => script.scriptName === (preferredScriptByWorkspace[previewKey] ?? null),
          ) ?? (services.length === 1 ? services[0] : null))
        : null,
    [previewKey, services, preferredScriptByWorkspace],
  );
  // The dev preview waits for the daemon's own reports instead of assuming the start request
  // made the service reachable, so the pending flag is the source of truth for "starting".
  const [pendingPreviewScriptName, setPendingPreviewScriptName] = useState<string | null>(null);
  const [previewTerminalIdByScript, setPreviewTerminalIdByScript] = useState<
    Record<string, string>
  >({});
  const [menuOpen, setMenuOpen] = useState(false);
  const pendingRestartRef = useRef<Set<string>>(new Set());
  const activePreviewScriptRef = useRef<string | null>(null);
  const previewStartNamesRef = useRef<Set<string>>(new Set());

  const cancelPendingPreview = useCallback((scriptName: string) => {
    if (activePreviewScriptRef.current !== scriptName) {
      return;
    }
    activePreviewScriptRef.current = null;
    setPendingPreviewScriptName((current) => (current === scriptName ? null : current));
  }, []);

  const recordPreviewTerminalId = useCallback(
    (scriptName: string, terminalId: string) => {
      setPreviewTerminalIdByScript((current) => ({ ...current, [scriptName]: terminalId }));
      onPreviewTerminalStarted?.(terminalId);
    },
    [onPreviewTerminalStarted],
  );

  // Starting a preview must not yank the workspace to the service's terminal: the launch is
  // registered as a preview start and its terminal id goes to the preview flow instead.
  const startScriptMutation = useMutation({
    mutationFn: (scriptName: string) =>
      requestStartWorkspaceScript({
        client,
        workspaceId,
        scriptName,
        clientUnavailableMessage: t("common.errors.daemonClientUnavailable"),
      }),
    onError: (error, scriptName) => {
      if (previewStartNamesRef.current.has(scriptName)) onPreviewPendingChange?.(false);
      previewStartNamesRef.current.delete(scriptName);
      cancelPendingPreview(scriptName);
      showScriptMutationError({
        toast,
        error,
        fallbackMessage: t("workspace.scripts.states.startFailed", { scriptName }),
      });
    },
    onSuccess: (result, scriptName) => {
      const wasPreviewStart = previewStartNamesRef.current.has(scriptName);
      consumeScriptStartOutcome({
        result,
        scriptName,
        previewStartNames: previewStartNamesRef.current,
        onPreviewTerminal: recordPreviewTerminalId,
        onOrdinaryTerminal: input.onScriptTerminalStarted,
      });
      if (wasPreviewStart) onPreviewPendingChange?.(false);
    },
  });

  const stopScriptMutation = useMutation({
    mutationFn: (stopInput: {
      scriptName: string;
      terminalId?: string | null;
      isPreviewStop?: boolean;
    }) =>
      requestStopWorkspaceScript({
        client,
        scripts,
        scriptName: stopInput.scriptName,
        terminalId: stopInput.terminalId,
        clientUnavailableMessage: t("common.errors.daemonClientUnavailable"),
        stopFailedMessage: (scriptName) => t("workspace.scripts.states.stopFailed", { scriptName }),
      }),
    onError: (error, stopInput) => {
      pendingRestartRef.current.delete(stopInput.scriptName);
      showScriptMutationError({
        toast,
        error,
        fallbackMessage: t("workspace.scripts.states.stopFailed", {
          scriptName: stopInput.scriptName,
        }),
      });
    },
    onSuccess: (_result, stopInput) => {
      // Only the preview's own Stop closes the preview, and only once the stop succeeded.
      // A refused stop keeps the preview and its error is already surfaced.
      if (stopInput.isPreviewStop) {
        preview?.onClosePreview(stopInput.scriptName);
      }
    },
  });

  // Restart = kill the script terminal, then start again once the daemon
  // reports the script as stopped (it tears the runtime entry down on exit).
  const startScript = startScriptMutation.mutate;
  const stopScript = useCallback(
    (scriptName: string) => stopScriptMutation.mutate({ scriptName }),
    [stopScriptMutation],
  );
  const restartScript = useCallback(
    (scriptName: string) => {
      pendingRestartRef.current.add(scriptName);
      stopScriptMutation.mutate({ scriptName });
    },
    [stopScriptMutation],
  );

  useEffect(() => {
    consumePendingRestarts({
      pending: pendingRestartRef.current,
      scripts,
      startScript,
    });
  }, [scripts, startScript]);

  const startPreviewService = useCallback(
    (scriptName: string) => {
      if (previewKey === null) {
        return;
      }
      const script = findStartablePreviewScript({ scripts, scriptName });
      if (!script) {
        return;
      }
      // One launch at a time, synchronously guarded so a double press cannot queue two starts.
      if (startScriptMutation.isPending || previewStartNamesRef.current.has(scriptName)) {
        return;
      }
      previewStartNamesRef.current.add(scriptName);
      onPreviewPendingChange?.(true);
      activePreviewScriptRef.current = scriptName;
      setPendingPreviewScriptName(scriptName);
      setPreferredScript(previewKey, scriptName);
      startScriptMutation.mutate(scriptName);
    },
    [previewKey, scripts, startScriptMutation, setPreferredScript, onPreviewPendingChange],
  );

  const stopPreviewService = useCallback(() => {
    const scriptName = preferredService?.scriptName;
    if (!scriptName) {
      return;
    }
    // Stopping cancels a still-pending preview open right away; the preview itself only
    // closes once the stop reports success.
    cancelPendingPreview(scriptName);
    stopScriptMutation.mutate({
      scriptName,
      terminalId: resolveKnownScriptTerminalId({
        script: preferredService,
        trackedByScript: previewTerminalIdByScript,
        trackedFirst: true,
      }),
      isPreviewStop: true,
    });
  }, [cancelPendingPreview, preferredService, previewTerminalIdByScript, stopScriptMutation]);

  const selectPreviewService = useCallback(
    (scriptName: string) => {
      if (previewKey === null) {
        return;
      }
      const script = scripts.find((candidate) => candidate.scriptName === scriptName);
      if (!script) {
        return;
      }
      setPreferredScript(previewKey, scriptName);
      const url = resolvePreviewServiceUrl({
        script,
        preferredRouteKind: input.preferredRouteKind,
        activeConnection,
      });
      if (url) {
        preview?.onOpenPreview({ scriptName, url });
        return;
      }
      startPreviewService(scriptName);
    },
    [
      activeConnection,
      input.preferredRouteKind,
      preview,
      previewKey,
      scripts,
      setPreferredScript,
      startPreviewService,
    ],
  );

  const showUnhealthyPreviewToast = useCallback(
    (scriptName: string) => {
      toast.show(t("workspace.scripts.states.previewUnhealthy", { scriptName }), {
        variant: "error",
      });
    },
    [t, toast],
  );

  // Wait for the existing status reports: open once the service is running, healthy and has a
  // resolved URL. Unhealthy cancels the wait and reports; the logs stay reachable in the menu.
  useEffect(() => {
    const scriptName = pendingPreviewScriptName;
    if (!scriptName || !preview || activePreviewScriptRef.current !== scriptName) {
      return;
    }
    // The ref clears synchronously on cancel (stop, workspace change, unmount), while the
    // pending state only lands on the next render — this guard keeps stale reports from opening.
    applyPreviewWaitDecision({
      decision: resolvePreviewWaitDecision({
        script: scripts.find((candidate) => candidate.scriptName === scriptName),
        preferredRouteKind: input.preferredRouteKind,
        activeConnection,
      }),
      scriptName,
      cancel: cancelPendingPreview,
      open: preview.onOpenPreview,
      reportUnhealthy: showUnhealthyPreviewToast,
    });
  }, [
    activeConnection,
    cancelPendingPreview,
    input.preferredRouteKind,
    pendingPreviewScriptName,
    preview,
    scripts,
    showUnhealthyPreviewToast,
  ]);

  // A pending open does not survive a workspace change or unmount; stale reports are ignored
  // because the wait effect only acts while the pending flag for this workspace is set.
  useEffect(() => {
    return () => {
      activePreviewScriptRef.current = null;
      setPendingPreviewScriptName(null);
    };
  }, [serverId, workspaceId]);

  return {
    services,
    previewEnabled,
    preferredService,
    preferredScriptName: preferredService?.scriptName ?? null,
    isWaitingForPreview: previewEnabled && pendingPreviewScriptName !== null,
    hasKnownTerminal:
      resolveKnownScriptTerminalId({
        script: preferredService,
        trackedByScript: previewTerminalIdByScript,
      }) !== null,
    isStartPending: startScriptMutation.isPending,
    isStopPending: stopScriptMutation.isPending,
    menuOpen,
    setMenuOpen,
    openMenu: useCallback(() => setMenuOpen(true), []),
    startPreviewService,
    stopPreviewService,
    selectPreviewService,
    startScript,
    stopScript,
    restartScript,
  };
}

// The desktop control keeps preview and ordinary script actions in one menu.
// eslint-disable-next-line complexity
interface ConfigureServiceSheetProps {
  visible: boolean;
  client: DaemonClient | null;
  workspaceId: string;
  onClose: () => void;
  onSaved: (scriptName: string) => void;
}

function scriptCommand(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === "string").join("\n");
  return "";
}

function ServiceConfigOption({
  serviceName,
  entry,
  onSelect,
}: {
  serviceName: string;
  entry: PaseoScriptEntryRaw | undefined;
  onSelect: (serviceName: string, entry: PaseoScriptEntryRaw | undefined) => void;
}) {
  const handleSelect = useCallback(
    () => onSelect(serviceName, entry),
    [entry, onSelect, serviceName],
  );
  return <DropdownMenuItem onSelect={handleSelect}>{serviceName}</DropdownMenuItem>;
}

const serviceValidationTranslationKeys = {
  name_required: "workspace.scripts.states.invalidServiceName",
  command_required: "workspace.scripts.states.invalidServiceCommand",
  port_invalid: "workspace.scripts.states.invalidServicePort",
  name_collision: "workspace.scripts.states.serviceNameCollision",
} as const;

function ServiceConfigFields({
  loading,
  services,
  projectConfig,
  selectedService,
  selectedLabel,
  chooseService,
  name,
  setName,
  command,
  setCommand,
  port,
  setPort,
  validationCode,
  error,
  reload,
}: {
  loading: boolean;
  services: [string, PaseoScriptEntryRaw][];
  projectConfig: PaseoConfigRaw | null;
  selectedService: string;
  selectedLabel: string | null;
  chooseService: (serviceName: string, entry: PaseoScriptEntryRaw | undefined) => void;
  name: string;
  setName: (value: string) => void;
  command: string;
  setCommand: (value: string) => void;
  port: string;
  setPort: (value: string) => void;
  validationCode: WorkspaceScriptValidationError | null;
  error: string | null;
  reload: () => void;
}) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <View style={styles.configLoading}>
        <Text style={styles.configHint}>{t("workspace.scripts.states.configurationLoading")}</Text>
      </View>
    );
  }

  return (
    <>
      {services.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger style={styles.configServiceChoice} testID="workspace-service-choice">
            <Text style={styles.configLabel}>{selectedLabel}</Text>
            <ThemedChevronDown size={14} uniProps={extraMutedIconColorMapping} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" minWidth={220}>
            {services.map(([serviceName]) => (
              <ServiceConfigOption
                key={serviceName}
                serviceName={serviceName}
                entry={projectConfig?.scripts?.[serviceName]}
                onSelect={chooseService}
              />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <View style={styles.configField}>
        <Text style={styles.configLabel}>{t("workspace.scripts.states.serviceName")}</Text>
        <TextInput
          key={`name-${selectedService}`}
          testID="workspace-service-name"
          initialValue={name}
          onChangeText={setName}
          placeholder="dev"
          style={styles.configInput}
        />
        {validationCode === "name_required" || validationCode === "name_collision" ? (
          <Text testID="workspace-service-name-error" style={styles.configError}>
            {t(serviceValidationTranslationKeys[validationCode])}
          </Text>
        ) : null}
      </View>
      <View style={styles.configField}>
        <Text style={styles.configLabel}>{t("workspace.scripts.states.serviceCommand")}</Text>
        <TextInput
          key={`command-${selectedService}`}
          testID="workspace-service-command"
          multiline
          initialValue={command}
          onChangeText={setCommand}
          placeholder="npm run dev"
          style={styles.configCommand}
        />
        {validationCode === "command_required" ? (
          <Text testID="workspace-service-command-error" style={styles.configError}>
            {t("workspace.scripts.states.invalidServiceCommand")}
          </Text>
        ) : null}
      </View>
      <View style={styles.configField}>
        <Text style={styles.configLabel}>{t("workspace.scripts.states.servicePort")}</Text>
        <TextInput
          key={`port-${selectedService}`}
          testID="workspace-service-port"
          initialValue={port}
          onChangeText={setPort}
          placeholder={t("workspace.scripts.states.automaticPort")}
          style={styles.configInput}
        />
        {validationCode === "port_invalid" ? (
          <Text testID="workspace-service-port-error" style={styles.configError}>
            {t("workspace.scripts.states.invalidServicePort")}
          </Text>
        ) : null}
        {!port.trim() ? (
          <Text style={styles.configHint}>{t("workspace.scripts.states.automaticPortHint")}</Text>
        ) : null}
      </View>
      {error ? (
        <Alert testID="workspace-service-config-error" variant="error" title={error}>
          {error === t("workspace.scripts.states.configurationConflict") ? (
            <Button onPress={reload} variant="outline" size="sm">
              {t("workspace.scripts.actions.reloadConfiguration")}
            </Button>
          ) : null}
        </Alert>
      ) : null}
    </>
  );
}

function ConfigureServiceSheet({
  visible,
  client,
  workspaceId,
  onClose,
  onSaved,
}: ConfigureServiceSheetProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [projectConfig, setProjectConfig] = useState<PaseoConfigRaw | null>(null);
  const [workspaceConfig, setWorkspaceConfig] = useState<PaseoConfigRaw | null>(null);
  const [projectRevision, setProjectRevision] = useState<PaseoConfigRevision | null>(null);
  const [workspaceRevision, setWorkspaceRevision] = useState<PaseoConfigRevision | null>(null);
  const [name, setName] = useState("dev");
  const [command, setCommand] = useState("");
  const [port, setPort] = useState("");
  const [selectedService, setSelectedService] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);

  const services = useMemo(
    () =>
      Object.entries(projectConfig?.scripts ?? {}).filter(([, entry]) => entry.type === "service"),
    [projectConfig],
  );

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      const result = await client.readWorkspaceScriptConfiguration(workspaceId);
      if (result.error) throw new Error(result.error);
      setProjectConfig(result.projectConfig);
      setWorkspaceConfig(result.workspaceConfig);
      setProjectRevision(result.projectRevision);
      setWorkspaceRevision(result.workspaceRevision);
      const initial = Object.entries(result.projectConfig?.scripts ?? {}).find(
        ([, entry]) => entry.type === "service",
      );
      setSelectedService(initial?.[0] ?? "");
      setName(initial?.[0] ?? "dev");
      setCommand(initial ? scriptCommand(initial[1].command) : "");
      const initialPort = initial?.[1].port;
      setPort(
        typeof initialPort === "number" || typeof initialPort === "string"
          ? String(initialPort)
          : "",
      );
    } catch (loadError) {
      setError(
        loadError instanceof Error && loadError.message.includes("Update the host")
          ? t("workspace.scripts.states.updateHostForConfiguration")
          : t("workspace.scripts.states.configurationFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [client, t, workspaceId]);

  useEffect(() => {
    if (visible) void load();
  }, [load, visible]);

  const validationCode = validateWorkspaceScriptDraft({
    name,
    command,
    port,
    collides: Boolean(
      (projectConfig?.scripts?.[name.trim()] &&
        projectConfig.scripts[name.trim()]!.type !== "service") ||
      (workspaceConfig?.scripts?.[name.trim()] &&
        workspaceConfig.scripts[name.trim()]!.type !== "service"),
    ),
  });
  const validationError = validationCode
    ? t(serviceValidationTranslationKeys[validationCode])
    : null;

  const save = useCallback(async () => {
    if (!client || pendingRef.current || validationError) return;
    pendingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await client.writeWorkspaceScriptConfiguration({
        workspaceId,
        scriptName: name.trim(),
        command: command.trim(),
        port: port.trim() ? Number(port) : null,
        projectRevision,
        workspaceRevision,
      });
      setProjectRevision(result.projectRevision);
      setWorkspaceRevision(result.workspaceRevision);
      if (result.error) {
        setError(configurationWriteError(result.error, result.written, t));
        return;
      }
      if (result.written !== "both") {
        setError(t("workspace.scripts.states.configurationSaveFailed"));
        return;
      }
      const savedName = name.trim();
      onClose();
      onSaved(savedName);
    } catch {
      setError(t("workspace.scripts.states.configurationSaveFailed"));
    } finally {
      pendingRef.current = false;
      setSaving(false);
    }
  }, [
    client,
    command,
    name,
    onClose,
    onSaved,
    port,
    projectRevision,
    t,
    validationError,
    workspaceId,
    workspaceRevision,
  ]);

  const header = useMemo(
    () => ({ title: t("workspace.scripts.states.configureServiceTitle") }),
    [t],
  );
  const reload = useCallback(() => {
    void load();
  }, [load]);
  const savePress = useCallback(() => {
    void save();
  }, [save]);
  const chooseService = useCallback(
    (serviceName: string, entry: PaseoScriptEntryRaw | undefined) => {
      setSelectedService(serviceName);
      setName(serviceName);
      setCommand(scriptCommand(entry?.command));
      setPort(
        typeof entry?.port === "number" || typeof entry?.port === "string"
          ? String(entry.port)
          : "",
      );
    },
    [],
  );

  const selectedLabel = selectedService
    ? t("workspace.scripts.states.editService", { name: selectedService })
    : null;
  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      testID="workspace-service-config-sheet"
      desktopMaxWidth={560}
    >
      <View style={styles.configForm}>
        <ServiceConfigFields
          loading={loading}
          services={services}
          projectConfig={projectConfig}
          selectedService={selectedService}
          selectedLabel={selectedLabel}
          chooseService={chooseService}
          name={name}
          setName={setName}
          command={command}
          setCommand={setCommand}
          port={port}
          setPort={setPort}
          validationCode={validationCode}
          error={error}
          reload={reload}
        />
        <View style={styles.configFooter}>
          <Button
            onPress={onClose}
            variant="ghost"
            size="md"
            testID="workspace-service-config-cancel"
          >
            {t("workspace.scripts.actions.cancel")}
          </Button>
          <Button
            onPress={savePress}
            variant="default"
            size="md"
            disabled={loading || saving || Boolean(validationError)}
            testID="workspace-service-config-save"
          >
            {saving
              ? t("settings.project.actions.saving")
              : t("workspace.scripts.actions.saveAndLaunch")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function ConfigureServicePlay({
  client,
  workspaceId,
  hideLabels,
  onSaved,
}: {
  client: DaemonClient | null;
  workspaceId: string;
  hideLabels?: boolean;
  onSaved: (scriptName: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const openConfiguration = useCallback(() => {
    if (client?.getLastServerInfoMessage()?.features?.workspaceScriptConfiguration !== true) {
      toast.show(t("workspace.scripts.states.updateHostForConfiguration"), { variant: "error" });
      return;
    }
    setOpen(true);
  }, [client, t, toast]);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("workspace.scripts.actions.configureService")}
        testID="workspace-scripts-configure-service"
        onPress={openConfiguration}
        style={styles.splitButtonPrimary}
      >
        <View style={styles.splitButtonContent}>
          <ThemedPlay size={14} uniProps={mutedColorMapping} />
          {!hideLabels && (
            <Text style={styles.splitButtonText}>{t("workspace.scripts.actions.play")}</Text>
          )}
        </View>
      </Pressable>
      <ConfigureServiceSheet
        visible={open}
        client={client}
        workspaceId={workspaceId}
        onClose={close}
        onSaved={onSaved}
      />
    </>
  );
}

function EmptyWorkspaceScriptsButton({
  preview,
  client,
  workspaceId,
  hideLabels,
  onSaved,
}: {
  preview: WorkspaceScriptsPreviewActions | undefined;
  client: DaemonClient | null;
  workspaceId: string;
  hideLabels?: boolean;
  onSaved: (scriptName: string) => void;
}) {
  if (!preview) return null;
  return (
    <ConfigureServicePlay
      client={client}
      workspaceId={workspaceId}
      hideLabels={hideLabels}
      onSaved={onSaved}
    />
  );
}

export function WorkspaceScriptsButton({
  serverId,
  workspaceId,
  scripts,
  liveTerminalIds = [],
  onScriptTerminalStarted,
  onPreviewTerminalStarted,
  onPreviewPendingChange,
  onViewTerminal,
  onOpenUrlInBrowserTab,
  hideLabels,
  presentation = "split",
  preview,
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
  const [autoStartScriptName, setAutoStartScriptName] = useState<string | null>(null);
  const liveTerminalIdSet = useMemo(() => new Set(liveTerminalIds), [liveTerminalIds]);

  const scriptControls = useWorkspaceScriptControls({
    preview,
    serverId,
    workspaceId,
    scripts,
    client,
    activeConnection,
    preferredRouteKind,
    toast,
    onScriptTerminalStarted,
    onPreviewTerminalStarted,
    onPreviewPendingChange,
  });
  const startPreviewService = scriptControls.startPreviewService;

  useEffect(() => {
    if (
      !autoStartScriptName ||
      !scripts.some((script) => script.scriptName === autoStartScriptName)
    )
      return;
    startPreviewService(autoStartScriptName);
    setAutoStartScriptName(null);
  }, [autoStartScriptName, scripts, startPreviewService]);

  const onConfigurationSaved = useCallback((scriptName: string) => {
    setAutoStartScriptName(scriptName);
  }, []);

  const triggerStyle = useCallback(
    ({ hovered, pressed, open }: { hovered: boolean; pressed: boolean; open: boolean }) => [
      presentation === "ghost" ? styles.ghostButton : styles.splitButtonPrimary,
      (hovered || pressed || open) &&
        (presentation === "ghost" ? styles.ghostButtonHovered : styles.splitButtonPrimaryHovered),
    ],
    [presentation],
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
    return (
      <EmptyWorkspaceScriptsButton
        preview={preview}
        client={client}
        workspaceId={workspaceId}
        hideLabels={hideLabels}
        onSaved={onConfigurationSaved}
      />
    );
  }

  const hasAnyRunning = scripts.some((s) => s.lifecycle === "running");
  const triggerPlayMapping = hasAnyRunning ? blueColorMapping : mutedColorMapping;
  const triggerIconSize = presentation === "ghost" ? GHOST_TRIGGER_ICON_SIZE : 14;
  const triggerPlayProps =
    presentation === "ghost" ? { ...playFillTransparent, ...ghostPlayStroke } : playFillTransparent;

  return (
    <View style={styles.row}>
      <View style={presentation === "ghost" ? styles.ghostButtonFrame : styles.splitButton}>
        <DropdownMenu
          open={scriptControls.previewEnabled ? scriptControls.menuOpen : undefined}
          onOpenChange={scriptControls.previewEnabled ? scriptControls.setMenuOpen : undefined}
        >
          {preview && scriptControls.services.length === 0 && (
            <>
              <ConfigureServicePlay
                client={client}
                workspaceId={workspaceId}
                hideLabels={hideLabels}
                onSaved={onConfigurationSaved}
              />
              <DropdownMenuTrigger
                testID="workspace-scripts-button"
                style={styles.splitButtonSecondary}
                accessibilityRole="button"
                accessibilityLabel={t("workspace.scripts.accessibility.trigger")}
              >
                <ThemedChevronDown size={16} uniProps={extraMutedIconColorMapping} />
              </DropdownMenuTrigger>
            </>
          )}
          {scriptControls.previewEnabled && (
            <WorkspaceScriptsPreviewAction
              hideLabels={hideLabels}
              scriptName={scriptControls.preferredScriptName}
              isRunning={scriptControls.preferredService?.lifecycle === "running"}
              isWaiting={scriptControls.isWaitingForPreview}
              hasKnownTerminal={scriptControls.hasKnownTerminal}
              onChoose={scriptControls.openMenu}
              onStart={scriptControls.startPreviewService}
              onStop={scriptControls.stopPreviewService}
            />
          )}
          {!preview && (
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
                  <ThemedChevronDown size={16} uniProps={extraMutedIconColorMapping} />
                ) : null}
              </View>
            </DropdownMenuTrigger>
          )}
          <DropdownMenuContent
            align="end"
            minWidth={200}
            maxWidth={280}
            testID="workspace-scripts-menu"
          >
            {scriptControls.previewEnabled ? (
              <PreviewServiceMenuSection
                services={scriptControls.services}
                preferredScriptName={scriptControls.preferredScriptName}
                onSelectService={scriptControls.selectPreviewService}
              />
            ) : null}
            {scripts.map((script) => (
              <ScriptRow
                key={script.scriptName}
                script={script}
                liveTerminalIdSet={liveTerminalIdSet}
                activeConnection={activeConnection}
                isStartPending={scriptControls.isStartPending}
                isStopPending={scriptControls.isStopPending}
                onStartScript={scriptControls.startScript}
                onStopScript={scriptControls.stopScript}
                onRestartScript={scriptControls.restartScript}
                onCopyUrl={handleCopyUrl}
                preferredRouteKind={preferredRouteKind}
                onSelectRouteKind={handleSelectRouteKind}
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
  configForm: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
    gap: theme.spacing[4],
  },
  configLoading: {
    minHeight: 120,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
  },
  configField: {
    gap: theme.spacing[2],
  },
  configLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  configHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  configError: {
    color: theme.colors.palette.red[500],
    fontSize: theme.fontSize.sm,
  },
  configInput: {
    minHeight: 40,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    color: theme.colors.foreground,
  },
  configCommand: {
    minHeight: 88,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
    color: theme.colors.foreground,
  },
  configServiceChoice: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
  },
  configFooter: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
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
    borderColor: "transparent",
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
    backgroundColor: theme.colors.interactionHighlight,
  },
  splitButtonPrimary: {
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[2],
    },
    justifyContent: "center",
  },
  splitButtonPrimaryHovered: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  splitButtonSecondary: {
    paddingHorizontal: theme.spacing[1.5],
    justifyContent: "center",
  },
  splitButtonSecondaryContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  runningText: {
    color: theme.colors.palette.blue[500],
  },
  splitButtonText: {
    fontSize: theme.fontSize.sm,
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
  scriptHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    minHeight: MENU_ITEM_HEIGHT,
  },
  scriptIcon: {
    flexShrink: 0,
  },
  scriptName: {
    fontSize: theme.fontSize.base,
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
    fontSize: theme.fontSize.sm,
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
    backgroundColor: theme.colors.interactionHighlight,
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
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
}));
