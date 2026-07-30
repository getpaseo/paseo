import { Button } from "@/components/ui/button";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { AlertTriangle } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";

const ThemedAlertTriangle = withUnistyles(AlertTriangle);
const warningIconMapping = (theme: Theme) => ({ color: theme.colors.palette.amber[500] });

export type FileConflictAlertState =
  | { kind: "changed"; canOverwrite: boolean; onReload(): void; onOverwrite(): void }
  | { kind: "deleted" }
  | { kind: "checkFailed"; retrying: boolean; onRetry(): void };

export function FileConflictAlert({ state }: { state: FileConflictAlertState }) {
  const { t } = useTranslation();
  let title = t("panels.file.editor.changedOnDisk");
  if (state.kind === "deleted") title = t("panels.file.editor.deletedTitle");
  else if (state.kind === "checkFailed") title = t("panels.file.editor.checkFailedTitle");
  let description: string | undefined;
  if (state.kind !== "changed") description = t("panels.file.editor.preservedDescription");
  else if (state.canOverwrite) description = t("panels.file.editor.conflictDescription");

  return (
    <View style={styles.container} testID="file-conflict-alert" accessibilityRole="alert">
      <ThemedAlertTriangle size={ICON_SIZE.sm} uniProps={warningIconMapping} />
      <View style={styles.message}>
        <Text style={styles.title}>{title}</Text>
        {description ? <Text style={styles.description}>{description}</Text> : null}
      </View>
      {state.kind !== "deleted" ? (
        <View style={styles.actions}>
          {state.kind === "changed" && state.canOverwrite ? (
            <Button variant="outline" size="sm" onPress={state.onOverwrite}>
              {t("panels.file.editor.overwrite")}
            </Button>
          ) : null}
          {state.kind === "changed" ? (
            <Button variant="outline" size="sm" onPress={state.onReload}>
              {t("panels.file.editor.reload")}
            </Button>
          ) : null}
          {state.kind === "checkFailed" ? (
            <Button variant="outline" size="sm" onPress={state.onRetry} loading={state.retrying}>
              {t("common.actions.retry")}
            </Button>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.palette.amber[500],
    backgroundColor: theme.colors.surface1,
  },
  message: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  title: {
    color: theme.colors.palette.amber[500],
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  actions: {
    flexShrink: 0,
    flexDirection: "row",
    gap: theme.spacing[2],
  },
}));
