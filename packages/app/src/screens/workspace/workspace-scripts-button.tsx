import { type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import {
  ChevronDown,
  ExternalLink,
  Globe,
  LoaderCircle,
  Play,
  SquareTerminal,
} from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/contexts/toast-context";
import { openExternalUrl } from "@/utils/open-external-url";
import { resolveWorkspaceScriptLink } from "@/utils/workspace-script-links";

type Script = WorkspaceDescriptor["scripts"][number];

function getScriptHealthColor(
  health: Script["health"],
  theme: ReturnType<typeof useUnistyles>["theme"],
): string {
  if (health === "healthy") {
    return theme.colors.palette.blue[500];
  }
  if (health === "unhealthy") {
    return theme.colors.palette.red[500];
  }
  return theme.colors.foregroundMuted;
}

interface WorkspaceScriptsButtonProps {
  serverId: string;
  workspaceId: string;
  scripts: WorkspaceDescriptor["scripts"];
  hideLabels?: boolean;
}

export function WorkspaceScriptsButton({
  serverId,
  workspaceId,
  scripts,
  hideLabels,
}: WorkspaceScriptsButtonProps): ReactElement | null {
  const { theme } = useUnistyles();
  const toast = useToast();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const activeConnection = useHostRuntimeSnapshot(serverId)?.activeConnection ?? null;

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
  });

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
            style={({ hovered, pressed, open }) => [
              styles.splitButtonPrimary,
              (hovered || pressed || open) && styles.splitButtonPrimaryHovered,
            ]}
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
              {scripts.map((script) => {
                const isRunning = script.lifecycle === "running";
                const isService = (script.type ?? "service") === "service";
                const serviceLink = resolveWorkspaceScriptLink({ script, activeConnection });
                const isLinkable = isService && isRunning && !!serviceLink.openUrl;
                const exitCode = script.exitCode ?? null;

                let dotColor: string;
                if (isService) {
                  dotColor = isRunning
                    ? getScriptHealthColor(script.health, theme)
                    : theme.colors.foregroundMuted;
                } else if (isRunning) {
                  dotColor = theme.colors.palette.blue[500];
                } else if (exitCode === 0) {
                  dotColor = theme.colors.palette.green[500];
                } else if (exitCode !== null) {
                  dotColor = theme.colors.palette.red[500];
                } else {
                  dotColor = theme.colors.foregroundMuted;
                }

                return (
                  <Pressable
                    key={script.scriptName}
                    testID={`workspace-scripts-item-${script.scriptName}`}
                    accessibilityRole={isLinkable ? "link" : undefined}
                    accessibilityLabel={`${script.scriptName} script`}
                    style={({ hovered }) => [
                      styles.scriptRow,
                      hovered && isLinkable && styles.scriptRowHovered,
                    ]}
                    onPress={
                      isLinkable ? () => void openExternalUrl(serviceLink.openUrl!) : undefined
                    }
                    disabled={!isLinkable}
                  >
                    {({ hovered }) => (
                      <>
                        {isService ? (
                          <Globe size={14} color={dotColor} style={styles.scriptIcon} />
                        ) : (
                          <SquareTerminal size={14} color={dotColor} style={styles.scriptIcon} />
                        )}
                        <Text
                          style={[
                            styles.scriptName,
                            {
                              color: isRunning
                                ? theme.colors.foreground
                                : theme.colors.foregroundMuted,
                            },
                          ]}
                          numberOfLines={1}
                        >
                          {script.scriptName}
                        </Text>
                        {isService && isRunning && serviceLink.labelUrl ? (
                          <Text style={styles.scriptUrl} numberOfLines={1}>
                            {serviceLink.labelUrl.replace(/^https?:\/\//, "")}
                          </Text>
                        ) : !isService && !isRunning && exitCode !== null && exitCode !== 0 ? (
                          <Text style={styles.scriptUrl} numberOfLines={1}>
                            exit {exitCode}
                          </Text>
                        ) : (
                          <View style={styles.spacer} />
                        )}
                        {isRunning ? (
                          isLinkable && hovered ? (
                            <View
                              style={[
                                styles.externalLinkOverlay,
                                {
                                  backgroundImage: `linear-gradient(to right, transparent, ${theme.colors.surface2} 40%)`,
                                } as any,
                              ]}
                            >
                              <ExternalLink size={12} color={theme.colors.foreground} />
                            </View>
                          ) : null
                        ) : (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Run ${script.scriptName} script`}
                            testID={`workspace-scripts-start-${script.scriptName}`}
                            hitSlop={4}
                            disabled={startScriptMutation.isPending}
                            onPress={(event) => {
                              event.stopPropagation();
                              startScriptMutation.mutate(script.scriptName);
                            }}
                            style={styles.startButton}
                          >
                            {({ hovered: actionHovered }) =>
                              startScriptMutation.isPending &&
                              startScriptMutation.variables === script.scriptName ? (
                                <LoaderCircle size={12} color={theme.colors.foregroundMuted} />
                              ) : (
                                <>
                                  <Play
                                    size={10}
                                    color={
                                      actionHovered
                                        ? theme.colors.foreground
                                        : theme.colors.foregroundMuted
                                    }
                                    fill="transparent"
                                  />
                                  <Text
                                    style={[
                                      styles.startButtonLabel,
                                      {
                                        color: actionHovered
                                          ? theme.colors.foreground
                                          : theme.colors.foregroundMuted,
                                      },
                                    ]}
                                  >
                                    Run
                                  </Text>
                                </>
                              )
                            }
                          </Pressable>
                        )}
                      </>
                    )}
                  </Pressable>
                );
              })}
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
  splitButtonPrimaryIconOnly: {
    paddingHorizontal: theme.spacing[2],
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
  scriptRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 6,
    minHeight: 28,
  },
  scriptRowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  scriptIcon: {
    flexShrink: 0,
  },
  scriptName: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    lineHeight: 18,
    flexShrink: 0,
  },
  scriptUrl: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
    flex: 1,
    minWidth: 0,
    textAlign: "right",
  },
  spacer: {
    flex: 1,
    minWidth: 0,
  },
  externalLinkOverlay: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    paddingLeft: theme.spacing[4],
    paddingRight: theme.spacing[3],
    alignItems: "center",
    justifyContent: "center",
  },
  startButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  startButtonLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
  },
}));
