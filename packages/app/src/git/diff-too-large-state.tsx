import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { FileWarning } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedFileWarning = withUnistyles(FileWarning);
const foregroundMutedIconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function DiffTooLargeState() {
  const { t } = useTranslation();

  return (
    <View style={styles.container} testID="diff-too-large">
      <ThemedFileWarning size={ICON_SIZE.lg} uniProps={foregroundMutedIconColorMapping} />
      <View style={styles.copy}>
        <Text style={styles.title}>{t("workspace.git.diff.previewTooLargeTitle")}</Text>
        <Text style={styles.description}>{t("workspace.git.diff.previewTooLargeDescription")}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[6],
    paddingTop: theme.spacing[16],
  },
  copy: {
    alignItems: "center",
    gap: theme.spacing[1],
    maxWidth: 360,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    textAlign: "center",
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
