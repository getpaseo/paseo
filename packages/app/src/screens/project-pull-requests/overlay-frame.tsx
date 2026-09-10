import type { ReactNode } from "react";
import { Modal } from "react-native";

export function OverlayFrame({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <Modal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose}>
      {children}
    </Modal>
  );
}
