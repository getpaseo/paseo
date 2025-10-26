import { useEffect, useState } from "react";
import { View, Text, ScrollView, ActivityIndicator } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { useSession } from "@/contexts/session-context";

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
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  const { agents, gitDiffs, requestGitDiff } = useSession();
  const [isLoading, setIsLoading] = useState(true);

  const agent = agentId ? agents.get(agentId) : undefined;
  const diffText = agentId ? gitDiffs.get(agentId) : undefined;

  useEffect(() => {
    if (!agentId) {
      setIsLoading(false);
      return;
    }

    if (diffText !== undefined) {
      setIsLoading(false);
      return;
    }

    requestGitDiff(agentId);

    const timeout = setTimeout(() => {
      setIsLoading(false);
    }, 5000);

    return () => clearTimeout(timeout);
  }, [agentId, diffText, requestGitDiff]);

  useEffect(() => {
    if (diffText !== undefined) {
      setIsLoading(false);
    }
  }, [diffText]);

  if (!agent) {
    return (
      <View style={styles.container}>
        <BackHeader title="Changes" />
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
                <ScrollView
                  horizontal
                  nestedScrollEnabled
                  showsHorizontalScrollIndicator
                  bounces={false}
                  overScrollMode="never"
                  contentContainerStyle={styles.diffScrollContent}
                >
                  <View style={styles.diffLinesContainer}>
                    {file.lines.map((line, lineIndex) => (
                      <Text
                        key={lineIndex}
                        style={[
                          styles.diffLine,
                          line.type === "add" && styles.addLine,
                          line.type === "remove" && styles.removeLine,
                          line.type === "header" && styles.headerLine,
                          line.type === "context" && styles.contextLine,
                        ]}
                      >
                        {line.content}
                      </Text>
                    ))}
                  </View>
                </ScrollView>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    padding: theme.spacing[4],
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
  diffScrollContent: {
    flexDirection: "column",
    alignItems: "flex-start",
    paddingBottom: theme.spacing[2],
  },
  diffLinesContainer: {
    alignSelf: "flex-start",
  },
  diffLine: {
    fontSize: theme.fontSize.xs,
    fontFamily: "monospace",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    flexShrink: 0,
    minWidth: "100%",
  },
  addLine: {
    backgroundColor: theme.colors.palette.green[900],
    color: theme.colors.palette.green[200],
  },
  removeLine: {
    backgroundColor: theme.colors.palette.red[900],
    color: theme.colors.palette.red[200],
  },
  headerLine: {
    color: theme.colors.mutedForeground,
    backgroundColor: theme.colors.muted,
  },
  contextLine: {
    color: theme.colors.mutedForeground,
  },
}));
