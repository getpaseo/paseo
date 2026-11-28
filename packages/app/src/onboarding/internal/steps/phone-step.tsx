import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AppleIcon } from "@/components/icons/apple-icon";
import { GooglePlayIcon } from "@/components/icons/google-play-icon";
import { Button } from "@/components/ui/button";
import { WaysToConnect } from "@/devices";
import { ICON_SIZE } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";

const APP_STORE_URL = "https://apps.apple.com/app/paseo-pocket-engineer/id6758887924";
const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=sh.paseo";

// Button calls a one-argument function with its icon colour, so the Apple mark follows the theme.
const renderAppleIcon = (color: string) => <AppleIcon color={color} size={ICON_SIZE.sm} />;
const renderGooglePlayIcon = () => <GooglePlayIcon size={ICON_SIZE.sm} />;

function openUrl(url: string) {
  void openExternalUrl(url).catch(console.error);
}

/** Get the app, then connect it the same ways the host's Devices settings offer. */
export function PhoneStep({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const openAppStore = useCallback(() => openUrl(APP_STORE_URL), []);
  const openPlayStore = useCallback(() => openUrl(PLAY_STORE_URL), []);

  return (
    <View style={styles.container}>
      <View style={styles.storeLinks}>
        <Button variant="outline" leftIcon={renderAppleIcon} onPress={openAppStore}>
          {t("onboarding.setup.steps.phone.appStore")}
        </Button>
        <Button variant="outline" leftIcon={renderGooglePlayIcon} onPress={openPlayStore}>
          {t("onboarding.setup.steps.phone.googlePlay")}
        </Button>
      </View>
      <WaysToConnect serverId={serverId} />
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
