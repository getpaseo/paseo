import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { WorkspaceFilePreviewProps } from "@/components/workspace-file-previews/types";

export function WorkspaceDocxPreview(_props: WorkspaceFilePreviewProps) {
  return (
    <View style={styles.centerState}>
      <Text style={styles.emptyText}>DOCX preview is unavailable on this platform.</Text>
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
