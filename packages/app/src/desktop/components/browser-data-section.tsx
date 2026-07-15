import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { getDesktopHost } from "@/desktop/host";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";

export function BrowserDataSection() {
  const { t } = useTranslation();
  const toast = useToast();
  const [isClearing, setIsClearing] = useState(false);

  const handleClear = useCallback(async () => {
    if (isClearing) {
      return;
    }

    try {
      const confirmed = await confirmDialog({
        title: t("settings.general.browserData.confirmTitle"),
        message: t("settings.general.browserData.confirmMessage"),
        confirmLabel: t("settings.general.browserData.clear"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }

      const clearProfile = getDesktopHost()?.browser?.clearProfile;
      if (!clearProfile) {
        throw new Error("Electron browser profile bridge is unavailable");
      }

      setIsClearing(true);
      await clearProfile();
      toast.show(t("settings.general.browserData.success"), { variant: "success" });
    } catch {
      toast.error(t("settings.general.browserData.error"));
    } finally {
      setIsClearing(false);
    }
  }, [isClearing, t, toast]);
  const clearButtonLabel = isClearing
    ? t("settings.general.browserData.clearing")
    : t("settings.general.browserData.clear");

  return (
    <SettingsSection title={t("settings.general.browserData.title")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.general.browserData.title")}</Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.general.browserData.description")}
            </Text>
          </View>
          <Button
            variant="destructive"
            size="sm"
            loading={isClearing}
            disabled={isClearing}
            onPress={handleClear}
          >
            {clearButtonLabel}
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}
