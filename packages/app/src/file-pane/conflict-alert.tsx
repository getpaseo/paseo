import { Button } from "@/components/ui/button";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { AlertTriangle } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";

const ThemedAlertTriangle = withUnistyles(AlertTriangle);
const warningIconMapping = (theme: Theme) => ({ color: theme.colors.palette.amber[500] });

export function FileConflictAlert({
  unavailable,
  modified,
  onOverwrite,
  onReload,
}: {
  unavailable: boolean;
  modified: boolean;
  onOverwrite(): void;
  onReload(): void;
}) {
  const { t } = useTranslation();
  const canReload = !unavailable;
  const canOverwrite = canReload && modified;
  const title = unavailable
    ? t("panels.file.editor.deletedTitle")
    : t("panels.file.editor.changedOnDisk");
  let description: string | undefined;
  if (unavailable) description = t("panels.file.editor.deletedDescription");
  else if (canOverwrite) description = t("panels.file.editor.conflictDescription");

  return (
    <View style={styles.container} testID="file-conflict-alert" accessibilityRole="alert">
      <ThemedAlertTriangle size={ICON_SIZE.sm} uniProps={warningIconMapping} />
      <View style={styles.message}>
        <Text style={styles.title}>{title}</Text>
        {description ? <Text style={styles.description}>{description}</Text> : null}
      </View>
      {canOverwrite || canReload ? (
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
