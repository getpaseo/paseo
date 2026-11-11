import { Modal as NativeModal, type ModalProps as NativeModalProps } from "react-native";
import { useDismissibleOverlay } from "@/components/ui/overlay-dismissal";

// React Native defaults iPhone modals to portrait even when the app supports rotation.
const orientations: NonNullable<NativeModalProps["supportedOrientations"]> = [
  "portrait",
  "portrait-upside-down",
  "landscape-left",
  "landscape-right",
];

type ModalProps = Omit<NativeModalProps, "onRequestClose"> & {
  /** Back, Escape, and a composer taking focus all close the modal through this. */
  onRequestClose?: () => void;
};

function noClose() {}

export function Modal(props: ModalProps) {
  const { visible = true, onRequestClose } = props;
  useDismissibleOverlay(visible && onRequestClose !== undefined, onRequestClose ?? noClose);
  return <NativeModal supportedOrientations={orientations} {...props} />;
}
