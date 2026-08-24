import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { PairDeviceSection } from "@/desktop/components/pair-device-section";

export interface PairDeviceModalProps {
  serverId: string;
  visible: boolean;
  onClose: () => void;
  testID?: string;
}

const SNAP_POINTS: string[] = ["72%", "92%"];

export function PairDeviceModal({ serverId, visible, onClose, testID }: PairDeviceModalProps) {
  const { t } = useTranslation();
  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.host.pairDevices.rowTitle") }),
    [t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      snapPoints={SNAP_POINTS}
      desktopMaxWidth={480}
      testID={testID}
    >
      <PairDeviceSection serverId={serverId} onClose={onClose} />
    </AdaptiveModalSheet>
  );
}
