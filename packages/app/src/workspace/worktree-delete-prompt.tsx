import { useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";

// Inline keep/delete confirmation shown when archiving the last reference to a
// Paseo-owned worktree. "Keep on disk" is the default, non-destructive choice;
// "Delete" removes the worktree directory from disk.
export function WorktreeDeletePrompt({
  visible,
  workspaceName,
  onKeep,
  onDelete,
  onCancel,
}: {
  visible: boolean;
  workspaceName: string;
  onKeep: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const header = useMemo(
    () => ({ title: t("sidebar.workspace.confirmations.deleteWorktreePrompt.title") }),
    [t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onCancel}
      scrollable={false}
      desktopMaxWidth={420}
      testID="worktree-delete-confirm"
    >
      <View style={styles.body}>
        <Text style={styles.message}>
          {t("sidebar.workspace.confirmations.deleteWorktreePrompt.message", {
            workspaceName,
          })}
        </Text>
        <View style={styles.actions}>
          <Button variant="default" onPress={onKeep} testID="worktree-delete-confirm-keep">
            {t("sidebar.workspace.confirmations.deleteWorktreePrompt.keep")}
          </Button>
          <Button variant="destructive" onPress={onDelete} testID="worktree-delete-confirm-delete">
            {t("sidebar.workspace.confirmations.deleteWorktreePrompt.delete")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
  },
  message: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
