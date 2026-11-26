import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsDetailRow, SettingsSection } from "@/components/settings";
import { StatusBadge } from "@/components/ui/status-badge";
import { PairDeviceModal } from "./pair-device-modal";
import { CONNECTIVITY_DOCS_URL } from "./pair-device-section";
import { TailscaleRow } from "./tailscale-row";

/**
 * The ways another device can connect to a host: Relay, which pairs through a QR code in a sheet,
 * and Tailscale, a switch and an address. Settings and the setup's phone step show this same block.
 */
export function WaysToConnect({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const [pairing, setPairing] = useState(false);
  const openPairing = useCallback(() => setPairing(true), []);
  const closePairing = useCallback(() => setPairing(false), []);
  const recommended = useMemo(
    () => <StatusBadge size="xs" variant="success" label={t("devices.recommended")} />,
    [t],
  );
  const docsLink = useMemo(
    () => ({
      href: CONNECTIVITY_DOCS_URL,
      label: t("devices.docs"),
      accessibilityLabel: t("devices.docsAccessibility"),
    }),
    [t],
  );

  return (
    <SettingsSection title={t("devices.waysToConnect")} link={docsLink}>
      <SettingsCard>
        <SettingsDetailRow
          label={t("devices.relay.title")}
          labelAccessory={recommended}
          hint={t("devices.relay.hint")}
          onPress={openPairing}
          testID="devices-relay"
        />
        <TailscaleRow serverId={serverId} />
      </SettingsCard>
      <PairDeviceModal
        serverId={serverId}
        visible={pairing}
        onClose={closePairing}
        testID="devices-relay-pairing"
      />
    </SettingsSection>
  );
}
