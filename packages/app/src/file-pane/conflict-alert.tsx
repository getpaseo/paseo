import { Button } from "@/components/ui/button";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { FileVersion } from "@getpaseo/protocol/messages";
import { AlertTriangle } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";

const ThemedAlertTriangle = withUnistyles(AlertTriangle);
const warningIconMapping = (theme: Theme) => ({ color: theme.colors.palette.amber[500] });

export function FileConflictAlert({
  fileStatus,
  modified,
  onOverwrite,
  onReload,
  onRetry,
}: {
  fileStatus: FileVersion["status"];
  modified: boolean;
  onOverwrite(): void;
  onReload(): void;
  onRetry(): void;
}) {
  const { t } = useTranslation();
  const canReload = fileStatus === "ready";
  const canOverwrite = canReload && modified;
  const canRetry = fileStatus === "error";
  let title = t("panels.file.editor.changedOnDisk");
  if (fileStatus === "missing") title = t("panels.file.editor.deletedTitle");
  else if (fileStatus === "error") title = t("panels.file.editor.checkFailedTitle");
  let description: string | undefined;
  if (fileStatus !== "ready") description = t("panels.file.editor.preservedDescription");
  else if (canOverwrite) description = t("panels.file.editor.conflictDescription");

  return (
    <View style={styles.container} testID="file-conflict-alert" accessibilityRole="alert">
      <ThemedAlertTriangle size={ICON_SIZE.sm} uniProps={warningIconMapping} />
      <View style={styles.message}>
        <Text style={styles.title}>{title}</Text>
        {description ? <Text style={styles.description}>{description}</Text> : null}
      </View>
      {canOverwrite || canReload || canRetry ? (
        <View style={styles.actions}>
          {canOverwrite ? (
            <Button variant="outline" size="sm" onPress={onOverwrite}>
              {t("panels.file.editor.overwrite")}
            </Button>
          ) : null}
          {canReload ? (
            <Button variant="outline" size="sm" onPress={onReload}>
              {t("panels.file.editor.reload")}
            </Button>
          ) : null}
          {canRetry ? (
            <Button variant="outline" size="sm" onPress={onRetry}>
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
