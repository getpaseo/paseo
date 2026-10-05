import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Monitor } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useDesktopSettings, type DesktopSettings } from "@/desktop/settings/desktop-settings";
import { useDaemonStatus } from "@/desktop/hooks/use-daemon-status";
import { useBuiltInDaemonManagement } from "@/desktop/hooks/use-built-in-daemon-management";

export function WelcomeLocalDaemon() {
  const { t } = useTranslation();
  const { settings, updateSettings, isLoading } = useDesktopSettings();
  const { data, setStatus, refetch } = useDaemonStatus();
  const updateDaemonSettings = useCallback(
    (daemon: Partial<DesktopSettings["daemon"]>) => updateSettings({ daemon }),
    [updateSettings],
  );
  const { enable, isUpdating } = useBuiltInDaemonManagement({
    daemonStatus: data?.status ?? null,
    settings: settings.daemon,
    updateSettings: updateDaemonSettings,
    setStatus,
    refreshStatus: refetch,
  });
  const handleEnable = useCallback(() => {
    void enable();
  }, [enable]);
  return (
    <View style={styles.container}>
      <Button
        variant="outline"
        size="lg"
        leftIcon={Monitor}
        testID="welcome-enable-local-daemon"
        disabled={isLoading || isUpdating}
        loading={isUpdating}
        onPress={handleEnable}
      >
        {t("settings.enableBuiltInDaemon")}
      </Button>
      <Text style={styles.hint}>{t("onboarding.localDaemonHint")}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[2] },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, textAlign: "center" },
}));
