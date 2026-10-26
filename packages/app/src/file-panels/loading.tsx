import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** The file tab's loading state. It covers the whole panel, so a panel can render beneath it. */
export function FilePanelLoading() {
  const { t } = useTranslation();
  return (
    <View style={styles.overlay} testID="file-preview-loading">
      <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
      <Text style={styles.text}>{t("panels.file.loading")}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface0,
  },
  text: {
    marginTop: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
