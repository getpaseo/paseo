import { Fragment, useCallback, useMemo, type ReactElement } from "react";
import type { GestureResponderEvent } from "react-native";
import { Pressable, Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, ExternalLink, Globe, Play, SquareTerminal } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/contexts/toast-context";
import { isNative } from "@/constants/platform";
import { openExternalUrl } from "@/utils/open-external-url";
import { resolveWorkspaceScriptLink } from "@/utils/workspace-script-links";

type ScriptActionIcon = "start" | "view";

interface WorkspaceScriptsButtonProps {
  serverId: string;
  workspaceId: string;
  scripts: WorkspaceDescriptor["scripts"];
  liveTerminalIds?: readonly string[];
  onScriptTerminalStarted?: (terminalId: string) => void;
  onViewTerminal?: (terminalId: string) => void;
  hideLabels?: boolean;
}

interface ScriptActionButtonProps {
  accessibilityLabel: string;
  disabled?: boolean;
  icon: ScriptActionIcon;
  label: string;
  onPress: () => void;
  testID: string;
}

interface ScriptActionButtonChildrenProps {
  hovered?: boolean;
  icon: ScriptActionIcon;
  label: string;
  theme: ReturnType<typeof useUnistyles>["theme"];
}

function ScriptActionButtonChildren({
  hovered,
  icon,
  label,
  theme,
}: ScriptActionButtonChildrenProps): ReactElement {
  const color = hovered ? theme.colors.foreground : theme.colors.foregroundMuted;
  const iconProps = { size: 10, color };
  const iconElement =
    icon === "view" ? (
      <SquareTerminal {...iconProps} />
    ) : (
      <Play {...iconProps} fill="transparent" />
    );
  const labelStyle = useMemo(() => [styles.actionButtonLabel, { color }], [color]);
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
  const { theme } = useUnistyles();

  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onPress();
    },
    [onPress],
  );

  const renderChildren = useCallback(
    ({ hovered }: { hovered?: boolean }) => (
      <ScriptActionButtonChildren hovered={hovered} icon={icon} label={label} theme={theme} />
    ),
    [icon, label, theme],
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
}

interface HostLinkChildrenProps {
  hovered?: boolean;
  disabled: boolean;
  label: string;
  theme: ReturnType<typeof useUnistyles>["theme"];
}

function HostLinkChildren({
  hovered,
  disabled,
  label,
  theme,
}: HostLinkChildrenProps): ReactElement {
  const showIcon = !disabled && (hovered || isNative);
  const color = hovered && !disabled ? theme.colors.foreground : theme.colors.foregroundMuted;
  const hostLabelStyle = useMemo(() => [styles.hostLabel, { color }], [color]);
  return (
    <>
      <Text style={hostLabelStyle} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.hostIconSlot}>
        {showIcon ? <ExternalLink size={10} color={color} /> : null}
      </View>
    </>
  );
}

function HostLinkRow({ label, url, scriptName }: HostLinkProps): ReactElement {
  const { theme } = useUnistyles();
  const disabled = !url;

  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      if (url) void openExternalUrl(url);
    },
    [url],
  );

  const renderChildren = useCallback(
    ({ hovered }: { hovered?: boolean }) => (
      <HostLinkChildren hovered={hovered} disabled={disabled} label={label} theme={theme} />
    ),
    [disabled, label, theme],
  );

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open ${scriptName} at ${label}`}
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
  const { theme } = useUnistyles();
  const color = code === 0 ? theme.colors.foregroundMuted : theme.colors.palette.red[300];
  const exitTextStyle = useMemo(() => [styles.exitBadgeText, { color }], [color]);
  return (
    <View style={styles.exitBadge}>
      <Text style={exitTextStyle}>exit {code}</Text>
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
  theme: ReturnType<typeof useUnistyles>["theme"];
  onStartScript: (scriptName: string) => void;
  onViewTerminal?: (terminalId: string) => void;
}

function ScriptRow({
  script,
  liveTerminalIdSet,
  activeConnection,
  isStartPending,
  theme,
  onStartScript,
  onViewTerminal,
}: ScriptRowProps): ReactElement {
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

  let iconColor = theme.colors.foregroundMuted;
  if (isService) {
    if (isRunning && script.health === "healthy") {
      iconColor = theme.colors.palette.green[500];
    } else if (isRunning && script.health === "unhealthy") {
      iconColor = theme.colors.palette.red[500];
    } else if (isRunning) {
      iconColor = theme.colors.palette.blue[500];
    }
  } else if (isRunning) {
    iconColor = theme.colors.palette.blue[500];
  }

  const ScriptIcon = isService ? Globe : SquareTerminal;
  const showExitBadge = !isRunning && exitCode !== null;

  const handleView = useCallback(() => {
    if (liveTerminalId) onViewTerminal?.(liveTerminalId);
  }, [liveTerminalId, onViewTerminal]);

  const handleRun = useCallback(() => {
    onStartScript(script.scriptName);
  }, [onStartScript, script.scriptName]);

  const scriptNameStyle = useMemo(
    () => [
      styles.scriptName,
      {
        color: isRunning ? theme.colors.foreground : theme.colors.foregroundMuted,
      },
    ],
    [isRunning, theme.colors.foreground, theme.colors.foregroundMuted],
  );

  let primaryAction: ReactElement | null = null;
  if (isRunning && liveTerminalId) {
    primaryAction = (
      <ScriptActionButton
        accessibilityLabel={`View ${script.scriptName} terminal`}
        testID={`workspace-scripts-view-${script.scriptName}`}
        icon="view"
        label="View"
        onPress={handleView}
      />
    );
  } else if (!isRunning) {
    primaryAction = (
      <ScriptActionButton
        accessibilityLabel={`Run ${script.scriptName} script`}
        testID={`workspace-scripts-start-${script.scriptName}`}
        disabled={isStartPending}
        icon="start"
        label="Run"
        onPress={handleRun}
      />
    );
  }

  return (
    <View
      testID={`workspace-scripts-item-${script.scriptName}`}
      accessibilityLabel={`${script.scriptName} script`}
      style={styles.scriptItem}
    >
      <View style={styles.scriptHeader}>
        <ScriptIcon size={14} color={iconColor} style={styles.scriptIcon} />
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
  hideLabels,
}: WorkspaceScriptsButtonProps): ReactElement | null {
  const { theme } = useUnistyles();
  const toast = useToast();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const activeConnection = useHostRuntimeSnapshot(serverId)?.activeConnection ?? null;
  const liveTerminalIdSet = useMemo(() => new Set(liveTerminalIds), [liveTerminalIds]);

  const startScriptMutation = useMutation({
    mutationFn: async (scriptName: string) => {
      if (!client) {
        throw new Error("Daemon client not available");
      }
      const result = await client.startWorkspaceScript(workspaceId, scriptName);
      if (result.error) {
        throw new Error(result.error);
      }
      return result;
    },
    onError: (error, scriptName) => {
      toast.show(error instanceof Error ? error.message : `Failed to start ${scriptName}`, {
        variant: "error",
      });
    },
    onSuccess: (result) => {
      if (result.terminalId) {
        onScriptTerminalStarted?.(result.terminalId);
      }
    },
  });

  const triggerStyle = useCallback(
    ({ hovered, pressed, open }: { hovered: boolean; pressed: boolean; open: boolean }) => [
      styles.splitButtonPrimary,
      (hovered || pressed || open) && styles.splitButtonPrimaryHovered,
    ],
    [],
  );

  const handleStartScript = useCallback(
    (scriptName: string) => startScriptMutation.mutate(scriptName),
    [startScriptMutation],
  );

  if (scripts.length === 0) {
    return null;
  }

  const hasAnyRunning = scripts.some((s) => s.lifecycle === "running");

  return (
    <View style={styles.row}>
      <View style={styles.splitButton}>
        <DropdownMenu>
          <DropdownMenuTrigger
            testID="workspace-scripts-button"
            style={triggerStyle}
            accessibilityRole="button"
            accessibilityLabel="Workspace scripts"
          >
            <View style={styles.splitButtonContent}>
              <Play
                size={14}
                color={
                  hasAnyRunning ? theme.colors.palette.blue[500] : theme.colors.foregroundMuted
                }
                fill="transparent"
              />
              {!hideLabels && <Text style={styles.splitButtonText}>Scripts</Text>}
              <ChevronDown size={14} color={theme.colors.foregroundMuted} />
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
                    theme={theme}
                    onStartScript={handleStartScript}
                    onViewTerminal={onViewTerminal}
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
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  actionButtonLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
  },
}));
