import { Fragment, useCallback, useMemo, type ReactElement } from "react";
import type { GestureResponderEvent } from "react-native";
import { Pressable, Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, ExternalLink, Globe, Play, SquareTerminal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  useDropdownMenuClose,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/contexts/toast-context";
import { isNative } from "@/constants/platform";
import { openServiceUrl } from "@/utils/open-service-url";
import { resolveWorkspaceScriptLink } from "@/utils/workspace-script-links";
import type { Theme } from "@/styles/theme";

type ScriptActionIcon = "start" | "view";

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

interface ScriptActionButtonProps {
  accessibilityLabel: string;
  disabled?: boolean;
  icon: ScriptActionIcon;
  label: string;
  onPress: () => void;
  testID: string;
}

const ThemedPlay = withUnistyles(Play);
const ThemedSquareTerminal = withUnistyles(SquareTerminal);
const ThemedGlobe = withUnistyles(Globe);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedExternalLink = withUnistyles(ExternalLink);

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

interface ScriptActionButtonChildrenProps {
  hovered?: boolean;
  icon: ScriptActionIcon;
  label: string;
}

function ScriptActionButtonChildren({
  hovered,
  icon,
  label,
}: ScriptActionButtonChildrenProps): ReactElement {
  const colorMapping = hovered ? foregroundColorMapping : mutedColorMapping;
  const iconElement =
    icon === "view" ? (
      <ThemedSquareTerminal size={10} uniProps={colorMapping} />
    ) : (
      <ThemedPlay size={10} uniProps={colorMapping} {...playFillTransparent} />
    );
  const labelStyle = hovered
    ? [styles.actionButtonLabel, styles.actionButtonLabelHovered]
    : styles.actionButtonLabel;
  return (
    <>
      {iconElement}
      <Text style={labelStyle}>{label}</Text>
    </>
  );
}

function ScriptActionButton({
  accessibilityLabel,
  disabled,
  icon,
  label,
  onPress,
  testID,
}: ScriptActionButtonProps): ReactElement {
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onPress();
    },
    [onPress],
  );

  const renderChildren = useCallback(
    ({ hovered }: { hovered?: boolean }) => (
      <ScriptActionButtonChildren hovered={hovered} icon={icon} label={label} />
    ),
    [icon, label],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      hitSlop={4}
      disabled={disabled}
      onPress={handlePress}
      style={styles.actionButton}
    >
      {renderChildren}
    </Pressable>
  );
}

function stripUrlProtocol(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

interface HostLinkProps {
  label: string;
  url: string | null;
  scriptName: string;
  onOpenInBrowserTab?: (url: string) => void;
}

interface HostLinkChildrenProps {
  hovered?: boolean;
  disabled: boolean;
  label: string;
}

function HostLinkChildren({ hovered, disabled, label }: HostLinkChildrenProps): ReactElement {
  const showIcon = !disabled && (hovered || isNative);
  const isActive = Boolean(hovered) && !disabled;
  const colorMapping = isActive ? foregroundColorMapping : mutedColorMapping;
  const hostLabelStyle = isActive ? [styles.hostLabel, styles.hostLabelActive] : styles.hostLabel;
  return (
    <>
      <Text style={hostLabelStyle} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.hostIconSlot}>
        {showIcon ? <ThemedExternalLink size={10} uniProps={colorMapping} /> : null}
      </View>
    </>
  );
}

function HostLinkRow({ label, url, scriptName, onOpenInBrowserTab }: HostLinkProps): ReactElement {
  const { t } = useTranslation();
  const disabled = !url;
  const closeMenu = useDropdownMenuClose();

  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      if (!url) return;
      closeMenu();
      void openServiceUrl(url, { openInApp: onOpenInBrowserTab });
    },
    [url, onOpenInBrowserTab, closeMenu],
  );

  const renderChildren = useCallback(
    ({ hovered }: { hovered?: boolean }) => (
      <HostLinkChildren hovered={hovered} disabled={disabled} label={label} />
    ),
    [disabled, label],
  );

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={t("workspace.scripts.accessibility.openAt", { scriptName, label })}
      disabled={disabled}
      hitSlop={2}
      onPress={handlePress}
      style={styles.hostRow}
    >
      {renderChildren}
    </Pressable>
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

interface HostLink {
  key: string;
  label: string;
  url: string | null;
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
  onStartScript: (scriptName: string) => void;
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
  onStartScript,
  onViewTerminal,
  onOpenUrlInBrowserTab,
}: ScriptRowProps): ReactElement {
  const { t } = useTranslation();
  const isRunning = script.lifecycle === "running";
  const isService = (script.type ?? "service") === "service";
  const exitCode = script.exitCode ?? null;
  const serviceLink = resolveWorkspaceScriptLink({ script, activeConnection });
  const serviceOpenUrl = isService && isRunning ? serviceLink.openUrl : null;
  const liveTerminalId =
    script.terminalId && liveTerminalIdSet.has(script.terminalId) ? script.terminalId : null;

  const hostLinks: HostLink[] = [];
  if (isService && isRunning) {
    const routedUrl = script.proxyUrl ?? serviceLink.labelUrl;
    if (routedUrl) {
      hostLinks.push({
        key: "proxy",
        label: stripUrlProtocol(routedUrl),
        url: serviceOpenUrl,
      });
    }
    if (script.port !== null) {
      const localhostLabel = `localhost:${script.port}`;
      const alreadyShown = hostLinks.some((l) => l.label === localhostLabel);
      if (!alreadyShown) {
        hostLinks.push({
          key: "localhost",
          label: localhostLabel,
          url: `http://localhost:${script.port}`,
        });
      }
    }
  }

  const iconColorMapping = resolveScriptIconColorMapping({ script, isService, isRunning });
  const ScriptIcon = isService ? ThemedGlobe : ThemedSquareTerminal;
  const showExitBadge = !isRunning && exitCode !== null;

  const handleView = useCallback(() => {
    if (liveTerminalId) onViewTerminal?.(liveTerminalId);
  }, [liveTerminalId, onViewTerminal]);

  const handleRun = useCallback(() => {
    onStartScript(script.scriptName);
  }, [onStartScript, script.scriptName]);

  const scriptNameStyle = useMemo(
    () => (isRunning ? [styles.scriptName, styles.scriptNameActive] : styles.scriptName),
    [isRunning],
  );

  let primaryAction: ReactElement | null = null;
  if (isRunning && liveTerminalId) {
    primaryAction = (
      <ScriptActionButton
        accessibilityLabel={t("workspace.scripts.accessibility.viewTerminal", {
          scriptName: script.scriptName,
        })}
        testID={`workspace-scripts-view-${script.scriptName}`}
        icon="view"
        label={t("workspace.scripts.actions.view")}
        onPress={handleView}
      />
    );
  } else if (!isRunning) {
    primaryAction = (
      <ScriptActionButton
        accessibilityLabel={t("workspace.scripts.accessibility.runScript", {
          scriptName: script.scriptName,
        })}
        testID={`workspace-scripts-start-${script.scriptName}`}
        disabled={isStartPending}
        icon="start"
        label={t("workspace.scripts.actions.run")}
        onPress={handleRun}
      />
    );
  }

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
        {primaryAction}
      </View>
      {hostLinks.length > 0 ? (
        <View style={styles.hostList}>
          {hostLinks.map((link) => (
            <HostLinkRow
              key={link.key}
              label={link.label}
              url={link.url}
              scriptName={script.scriptName}
              onOpenInBrowserTab={onOpenUrlInBrowserTab}
            />
          ))}
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
  const liveTerminalIdSet = useMemo(() => new Set(liveTerminalIds), [liveTerminalIds]);

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
                    onStartScript={handleStartScript}
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
    gap: theme.spacing[1.5],
    paddingVertical: 2,
    minHeight: 18,
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
  hostIconSlot: {
    width: 10,
    height: 10,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
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
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  actionButtonLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  actionButtonLabelHovered: {
    color: theme.colors.foreground,
  },
}));
