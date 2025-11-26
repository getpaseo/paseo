import { useEffect, useState } from "react";
import { View, Text, ScrollView, ActivityIndicator } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import type { SessionContextValue } from "@/contexts/session-context";
import type { ConnectionStatus } from "@/contexts/daemon-connections-context";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { formatConnectionStatus } from "@/utils/daemons";
import { useDaemonSession } from "@/hooks/use-daemon-session";

interface ParsedDiffFile {
  path: string;
  lines: Array<{
    type: "add" | "remove" | "context" | "header";
    content: string;
  }>;
}

function parseDiff(diffText: string): ParsedDiffFile[] {
  if (!diffText || diffText.trim().length === 0) {
    return [];
  }

  const files: ParsedDiffFile[] = [];
  const sections = diffText.split(/^diff --git /m).filter(Boolean);

  for (const section of sections) {
    const lines = section.split("\n");
    const firstLine = lines[0];
    
    const pathMatch = firstLine.match(/a\/(.*?) b\//);
    const path = pathMatch ? pathMatch[1] : "unknown";

    const parsedLines: ParsedDiffFile["lines"] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("index ")) {
        parsedLines.push({ type: "header", content: line });
      } else if (line.startsWith("+")) {
        parsedLines.push({ type: "add", content: line });
      } else if (line.startsWith("-")) {
        parsedLines.push({ type: "remove", content: line });
      } else {
        parsedLines.push({ type: "context", content: line });
      }
    }

    files.push({ path, lines: parsedLines });
  }

  return files;
}

export default function GitDiffScreen() {
  const { agentId, serverId } = useLocalSearchParams<{ agentId: string; serverId?: string }>();
  const resolvedServerId = typeof serverId === "string" ? serverId : undefined;
  const { connectionStates } = useDaemonConnections();
  const session = useDaemonSession(resolvedServerId, {
    suppressUnavailableAlert: true,
    allowUnavailable: true,
  });

  const connectionServerId = resolvedServerId ?? null;
  const connection = connectionServerId ? connectionStates.get(connectionServerId) : null;
  const serverLabel = connection?.daemon.label ?? connectionServerId ?? session?.serverId ?? "Active host";
  const connectionStatus = connection?.status ?? "idle";
  const connectionStatusLabel = formatConnectionStatus(connectionStatus);
  const lastError = connection?.lastError ?? null;

  if (!session) {
    return (
      <SessionUnavailableState
        serverLabel={serverLabel}
        connectionStatus={connectionStatus}
        connectionStatusLabel={connectionStatusLabel}
        lastError={lastError}
      />
    );
  }

  const routeServerId = resolvedServerId ?? session.serverId;

  return <GitDiffContent session={session} agentId={agentId} routeServerId={routeServerId} />;
}

function GitDiffContent({
  session,
  agentId,
  routeServerId,
}: {
  session: SessionContextValue;
  agentId?: string;
  routeServerId: string;
}) {
  const { agents, gitDiffs, requestGitDiff } = session;
  const [isLoading, setIsLoading] = useState(true);

  const agent = agentId ? agents.get(agentId) : undefined;
  const diffText = agentId ? gitDiffs.get(agentId) : undefined;

  useEffect(() => {
    if (!agentId) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    requestGitDiff(agentId);

    const timeout = setTimeout(() => {
      setIsLoading(false);
    }, 5000);

    return () => clearTimeout(timeout);
  }, [agentId, requestGitDiff]);

  useEffect(() => {
    if (diffText !== undefined) {
      setIsLoading(false);
    }
  }, [diffText]);

  if (!agent) {
    return (
      <View style={styles.container}>
        <BackHeader title="Changes" />
        <Text style={styles.metaText}>Server: {routeServerId}</Text>
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>Agent not found</Text>
        </View>
      </View>
    );
  }

  const isError = diffText?.startsWith("Error:");
  const parsedFiles = isError || !diffText ? [] : parseDiff(diffText);
  const hasChanges = parsedFiles.length > 0;

  return (
    <View style={styles.container}>
      <BackHeader title="Changes" />
      <Text style={styles.metaText}>Server: {routeServerId}</Text>

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.contentContainer}>
        {isLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" />
            <Text style={styles.loadingText}>Loading changes...</Text>
          </View>
        ) : isError ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{diffText}</Text>
          </View>
        ) : !hasChanges ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>No changes</Text>
          </View>
        ) : (
          parsedFiles.map((file, fileIndex) => (
            <View key={fileIndex} style={styles.fileSection}>
              <View style={styles.fileHeader}>
                <Text style={styles.filePath}>{file.path}</Text>
              </View>
              <View style={styles.diffContent}>
                <View style={styles.diffLinesContainer}>
                  {file.lines.map((line, lineIndex) => (
                    <View
                      key={lineIndex}
                      style={[
                        styles.diffLineContainer,
                        line.type === "add" && styles.addLineContainer,
                        line.type === "remove" && styles.removeLineContainer,
                        line.type === "header" && styles.headerLineContainer,
                        line.type === "context" && styles.contextLineContainer,
                      ]}
                    >
                      <Text
                        style={[
                          styles.diffLineText,
                          line.type === "add" && styles.addLineText,
                          line.type === "remove" && styles.removeLineText,
                          line.type === "header" && styles.headerLineText,
                          line.type === "context" && styles.contextLineText,
                        ]}
                      >
                        {line.content}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

function SessionUnavailableState({
  serverLabel,
  connectionStatus,
  connectionStatusLabel,
  lastError,
}: {
  serverLabel: string;
  connectionStatus: ConnectionStatus;
  connectionStatusLabel: string;
  lastError: string | null;
}) {
  const isConnecting = connectionStatus === "connecting";

  return (
    <View style={styles.container}>
      <BackHeader title="Changes" />
      <Text style={styles.metaText}>Server: {serverLabel}</Text>
      <View style={styles.errorContainer}>
        {isConnecting ? (
          <>
            <ActivityIndicator size="large" />
            <Text style={styles.loadingText}>Connecting to {serverLabel}...</Text>
            <Text style={styles.statusText}>We will show changes once this session is online.</Text>
          </>
        ) : (
          <>
            <Text style={styles.errorText}>
              Cannot load changes while {serverLabel} is {connectionStatusLabel.toLowerCase()}.
            </Text>
            <Text style={styles.statusText}>Connect this daemon or switch to another one to continue.</Text>
            {lastError ? <Text style={styles.errorDetails}>{lastError}</Text> : null}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  metaText: {
    paddingHorizontal: theme.spacing[6],
    marginBottom: theme.spacing[2],
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
  },
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    padding: theme.spacing[4],
    paddingBottom: theme.spacing[8],
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing[16],
    gap: theme.spacing[4],
  },
  loadingText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.mutedForeground,
  },
  errorContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing[16],
    paddingHorizontal: theme.spacing[6],
  },
  errorText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.destructive,
    textAlign: "center",
  },
  statusText: {
    marginTop: theme.spacing[3],
    textAlign: "center",
    fontSize: theme.fontSize.sm,
    color: theme.colors.mutedForeground,
  },
  errorDetails: {
    marginTop: theme.spacing[2],
    textAlign: "center",
    fontSize: theme.fontSize.xs,
    color: theme.colors.mutedForeground,
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing[16],
  },
  emptyText: {
    fontSize: theme.fontSize.lg,
    color: theme.colors.mutedForeground,
  },
  fileSection: {
    marginBottom: theme.spacing[6],
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    width: "100%",
  },
  fileHeader: {
    backgroundColor: theme.colors.muted,
    padding: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  filePath: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    fontFamily: "monospace",
  },
  diffContent: {
    backgroundColor: theme.colors.card,
  },
  diffLinesContainer: {
    width: "100%",
  },
  diffLineContainer: {
    width: "100%",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    flexDirection: "row",
    alignItems: "flex-start",
  },
  diffLineText: {
    fontSize: theme.fontSize.xs,
    fontFamily: "monospace",
    color: theme.colors.foreground,
    flexShrink: 1,
    flexWrap: "wrap",
    width: "100%",
  },
  addLineContainer: {
    backgroundColor: theme.colors.palette.green[900],
  },
  addLineText: {
    color: theme.colors.palette.green[200],
  },
  removeLineContainer: {
    backgroundColor: theme.colors.palette.red[900],
  },
  removeLineText: {
    color: theme.colors.palette.red[200],
  },
  headerLineContainer: {
    backgroundColor: theme.colors.muted,
  },
  headerLineText: {
    color: theme.colors.mutedForeground,
  },
  contextLineContainer: {
    backgroundColor: theme.colors.card,
  },
  contextLineText: {
    color: theme.colors.mutedForeground,
  },
}));
