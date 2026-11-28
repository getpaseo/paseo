import { useCallback, useMemo, useState } from "react";
import { Plus } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { PairDeviceSection } from "./pair-device-section";
import { WaysToConnect } from "./ways-to-connect";

const SNAP_POINTS: string[] = ["72%", "92%"];
const ThemedPlus = withUnistyles(Plus);
const iconProps = (theme: Theme) => ({
  size: theme.iconSize.sm,
  color: theme.colors.foreground,
});
const plusIcon = <ThemedPlus uniProps={iconProps} />;

type PairStep = "ways" | "relay";

export function PairDeviceHeaderAction({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState<PairStep>("ways");

  const handleOpen = useCallback(() => {
    setStep("ways");
    setVisible(true);
  }, []);
  const handleClose = useCallback(() => {
    setVisible(false);
    setStep("ways");
  }, []);
  const handleOpenRelay = useCallback(() => setStep("relay"), []);
  const handleBackToWays = useCallback(() => setStep("ways"), []);

  const header = useMemo<SheetHeader>(
    () =>
      step === "relay"
        ? {
            title: t("devices.relay.title"),
            back: {
              onPress: handleBackToWays,
              label: t("common.actions.back"),
            },
          }
        : {
            title: t("settings.host.pairDevices.rowTitle"),
          },
    [handleBackToWays, step, t],
  );

  return (
    <>
      <Button
        variant="secondary"
        leftIcon={plusIcon}
        onPress={handleOpen}
        testID="devices-pair-button"
      >
        {t("settings.host.pairDevices.rowTitle")}
      </Button>
      <AdaptiveModalSheet
        header={header}
        visible={visible}
        onClose={handleClose}
        snapPoints={SNAP_POINTS}
        desktopMaxWidth={480}
        desktopHeight={520}
        testID={step === "relay" ? "devices-relay-pairing" : "devices-pair-sheet"}
      >
        {step === "relay" ? (
          <PairDeviceSection serverId={serverId} onClose={handleClose} />
        ) : (
          <WaysToConnect serverId={serverId} onOpenRelay={handleOpenRelay} />
        )}
      </AdaptiveModalSheet>
    </>
  );
}
