import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Shortcut } from "@/components/ui/shortcut";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";

export function WorkspaceArchivedToast({ onUndo }: { onUndo: () => void }) {
  const { t } = useTranslation();
  const undoKeys = useShortcutKeys("undo-archive-workspace");
  const undoShortcut = useMemo(() => (undoKeys ? <Shortcut chord={undoKeys} /> : null), [undoKeys]);

  return (
    <View style={styles.row}>
      <Text style={styles.message}>{t("sidebar.workspace.toasts.archived")}</Text>
      <Button
        size="sm"
        onPress={onUndo}
        testID="workspace-archived-toast-undo"
        trailing={undoShortcut}
      >
        {t("sidebar.workspace.toasts.undoArchive")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  message: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
}));
