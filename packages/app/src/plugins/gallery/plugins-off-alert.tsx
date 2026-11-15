import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-api-context";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostLabel } from "./install-sheet";
import { pluginErrorText } from "./error-text";

/** Says that installed plugins are not running on this host, with the switch that runs them. */
export function PluginsOffAlert({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const hostLabel = useHostLabel(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [turningOn, setTurningOn] = useState(false);
  const turnOn = useCallback(async () => {
    setTurningOn(true);
    try {
      await patchConfig({ pluginsEnabled: true });
    } catch (error) {
      toast.error(pluginErrorText(error));
    } finally {
      setTurningOn(false);
    }
  }, [patchConfig, toast]);
  if (!config || config.pluginsEnabled === true) return null;
  return (
    <View style={styles.block}>
      <Alert
        size="sm"
        variant="warning"
        title={t("settings.plugins.gallery.off.title", { host: hostLabel })}
        testID="plugins-off"
      >
        <Button variant="outline" onPress={turnOn} loading={turningOn}>
          {t("settings.plugins.gallery.actions.turnOn")}
        </Button>
      </Alert>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  block: { marginBottom: theme.spacing[6] },
}));
