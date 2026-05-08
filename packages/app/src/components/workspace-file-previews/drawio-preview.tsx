import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { WorkspaceDrawioPreviewProps } from "@/components/workspace-file-previews/types";

export function WorkspaceDrawioPreview(_props: WorkspaceDrawioPreviewProps) {
  return (
    <View style={styles.centerState}>
      <Text style={styles.emptyText}>Draw.io preview is unavailable on this platform.</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface0,
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
