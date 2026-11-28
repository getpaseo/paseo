import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Shortcut } from "@/components/ui/shortcut";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";

export function WorkspaceArchivedToast({
  count = 1,
  message: customMessage,
  onUndo,
}: {
  count?: number;
  message?: string;
  onUndo: () => void;
}) {
  const { t } = useTranslation();
  const undoKeys = useShortcutKeys("undo-archive-workspace");
  const undoShortcut = useMemo(
    () => (undoKeys ? <Shortcut chord={undoKeys} style={styles.shortcut} /> : null),
    [undoKeys],
  );
  const message =
    customMessage ??
    (count === 1
      ? t("sidebar.workspace.toasts.archived")
      : t("sidebar.workspace.toasts.archivedCount", { count }));

  return (
    <View style={styles.row}>
      <Text style={styles.message}>{message}</Text>
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
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  // Cancels the badge's own inset, which would otherwise add to the button's gap.
  shortcut: {
    marginLeft: -theme.spacing[1],
  },
  message: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
}));
