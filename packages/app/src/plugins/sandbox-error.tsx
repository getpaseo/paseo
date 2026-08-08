import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

/**
 * A plugin that never posts `ready` would otherwise leave an indefinitely blank
 * pane. Both sandboxes give up after this and render the state below.
 */
export const PLUGIN_READY_TIMEOUT_MS = 10_000;

export function PluginReadyTimeout({ onRetry, testID }: { onRetry: () => void; testID?: string }) {
  const { t } = useTranslation();
  return (
    <View style={styles.container} testID={testID}>
      <Text style={styles.text}>{t("plugins.errors.readyTimeout")}</Text>
      <Button variant="outline" size="sm" onPress={onRetry}>
        {t("common.actions.retry")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
