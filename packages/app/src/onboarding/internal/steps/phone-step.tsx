import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { PairDeviceSection } from "@/desktop/components/pair-device-section";
import { openExternalUrl } from "@/utils/open-external-url";

const APP_STORE_URL = "https://apps.apple.com/app/paseo-pocket-engineer/id6758887924";
const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=sh.paseo";

export function PhoneStep({ serverId, onFinish }: { serverId: string; onFinish: () => void }) {
  const { t } = useTranslation();
  const openAppStore = useCallback(() => {
    void openExternalUrl(APP_STORE_URL).catch(console.error);
  }, []);
  const openPlayStore = useCallback(() => {
    void openExternalUrl(PLAY_STORE_URL).catch(console.error);
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.storeLinks}>
        <Button variant="outline" onPress={openAppStore}>
          {t("onboarding.setup.steps.phone.appStore")}
        </Button>
        <Button variant="outline" onPress={openPlayStore}>
          {t("onboarding.setup.steps.phone.googlePlay")}
        </Button>
      </View>
      <PairDeviceSection serverId={serverId} onClose={onFinish} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[6],
  },
  storeLinks: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
}));
