import { Modal as NativeModal, type ModalProps } from "react-native";

// React Native defaults iPhone modals to portrait even when the app supports rotation.
const orientations: NonNullable<ModalProps["supportedOrientations"]> = [
  "portrait",
  "portrait-upside-down",
  "landscape-left",
  "landscape-right",
];

export function Modal(props: ModalProps) {
  return <NativeModal supportedOrientations={orientations} {...props} />;
}
