import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export function PullRequestPaneSkeleton() {
  const { t } = useTranslation();

  return (
    <View
      style={styles.root}
      testID="pr-pane-loading"
      accessible
      accessibilityLabel={t("common.loading")}
    >
      <ThemedLoadingSpinner size="large" uniProps={foregroundMutedColorMapping} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
}));
