import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AppleIcon } from "@/components/icons/apple-icon";
import { GooglePlayIcon } from "@/components/icons/google-play-icon";
import { SettingsCard, SettingsDetailRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { PairDeviceModal } from "@/desktop/components/pair-device-modal";
import {
  CONNECTIVITY_DOCS_URL,
  TAILSCALE_DOCS_URL,
} from "@/desktop/components/pair-device-section";
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

/** Get the app, then connect it: the relay pairs in a modal, Tailscale is a docs page away. */
export function PhoneStep({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const [isPairing, setIsPairing] = useState(false);
  const openAppStore = useCallback(() => openUrl(APP_STORE_URL), []);
  const openPlayStore = useCallback(() => openUrl(PLAY_STORE_URL), []);
  const openTailscaleDocs = useCallback(() => openUrl(TAILSCALE_DOCS_URL), []);
  const openPairing = useCallback(() => setIsPairing(true), []);
  const closePairing = useCallback(() => setIsPairing(false), []);
  const recommendedBadge = useMemo(
    () => (
      <StatusBadge
        size="xs"
        variant="success"
        label={t("onboarding.setup.steps.phone.recommended")}
      />
    ),
    [t],
  );
  const docsLink = useMemo(
    () => ({
      href: CONNECTIVITY_DOCS_URL,
      label: t("onboarding.setup.steps.phone.connectDocs"),
      accessibilityLabel: t("onboarding.setup.steps.phone.openConnectDocs"),
    }),
    [t],
  );

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
      <SettingsSection title={t("onboarding.setup.steps.phone.connectTitle")} link={docsLink}>
        <SettingsCard>
          <SettingsDetailRow
            label={t("onboarding.setup.steps.phone.relay.title")}
            labelAccessory={recommendedBadge}
            hint={t("onboarding.setup.steps.phone.relay.hint")}
            onPress={openPairing}
            testID="onboarding-phone-relay"
          />
          <SettingsDetailRow
            label={t("onboarding.setup.steps.phone.tailscale.title")}
            hint={t("onboarding.setup.steps.phone.tailscale.hint")}
            summary={t("onboarding.setup.steps.phone.connectDocs")}
            onPress={openTailscaleDocs}
            external
            testID="onboarding-phone-tailscale"
          />
        </SettingsCard>
      </SettingsSection>
      <PairDeviceModal
        serverId={serverId}
        visible={isPairing}
        onClose={closePairing}
        testID="onboarding-pair-device-card"
      />
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
