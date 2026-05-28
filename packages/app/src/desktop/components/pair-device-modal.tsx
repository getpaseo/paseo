import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { PairDeviceSection } from "@/desktop/components/pair-device-section";

export interface PairDeviceModalProps {
  visible: boolean;
  onClose: () => void;
  testID?: string;
}

const SNAP_POINTS: string[] = ["82%", "94%"];
const PAIR_DEVICE_HEADER: SheetHeader = { title: "Pair a device" };

export function PairDeviceModal({ visible, onClose, testID }: PairDeviceModalProps) {
  return (
    <AdaptiveModalSheet
      header={PAIR_DEVICE_HEADER}
      visible={visible}
      onClose={onClose}
      snapPoints={SNAP_POINTS}
      desktopMaxWidth={640}
      testID={testID}
    >
      <PairDeviceSection />
    </AdaptiveModalSheet>
  );
}
