import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { PairDeviceSection } from "@/desktop/components/pair-device-section";

export interface PairDeviceModalProps {
  visible: boolean;
  onClose: () => void;
  testID?: string;
}

export function PairDeviceModal({ visible, onClose, testID }: PairDeviceModalProps) {
  return (
    <AdaptiveModalSheet
      title="Pair a device"
      visible={visible}
      onClose={onClose}
      snapPoints={["82%", "94%"]}
      desktopMaxWidth={640}
      testID={testID}
    >
      <PairDeviceSection />
    </AdaptiveModalSheet>
  );
}
