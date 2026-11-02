import {
  useSubscription,
  useWorkspace,
  type PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { diffWatch, type ChangedFile } from "../shared/diff";

const BASE = "HEAD";

export function DiffPanel({ workspaceId, theme, layout }: PluginWorkspacePanelProps) {
  const cwd = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const styles = useStyles(theme, layout.compact);
  if (!cwd) return <Text style={styles.muted}>Workspace unavailable</Text>;
  return <ChangedFiles cwd={cwd} styles={styles} />;
}

function ChangedFiles({ cwd, styles }: { cwd: string; styles: ReturnType<typeof useStyles> }) {
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  const subscription = useSubscription(diffWatch, { cwd, from: BASE }, (event) => {
    setFiles(event.files);
  });
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Changes against {BASE}</Text>
      <Text style={styles.muted}>{describe(subscription, files)}</Text>
      {files?.map((file) => (
        <View key={file.path} style={styles.row}>
          <Text style={styles.status}>{file.status}</Text>
          <Text style={styles.path} numberOfLines={1}>
            {file.path}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

function describe(
  subscription: ReturnType<typeof useSubscription>,
  files: ChangedFile[] | null,
): string {
  if (subscription.status === "error") return subscription.error.message;
  if (subscription.status === "closed") return "Stopped watching";
  if (!files) return "Reading changes…";
  if (files.length === 0) return "No changes";
  return files.length === 1 ? "1 file changed" : `${files.length} files changed`;
}

function useStyles(theme: PluginWorkspacePanelProps["theme"], compact: boolean) {
  return useMemo(
    () =>
      StyleSheet.create({
        screen: { flex: 1, backgroundColor: theme.colors.surface0 },
        content: { padding: compact ? 16 : 24, gap: 8 },
        title: { color: theme.colors.foreground, fontSize: 18, fontWeight: "600" },
        muted: { color: theme.colors.foregroundMuted },
        row: { flexDirection: "row", gap: 12, alignItems: "center" },
        status: { color: theme.colors.foregroundMuted, width: 72 },
        path: { color: theme.colors.foreground, flex: 1 },
      }),
    [theme, compact],
  );
}
