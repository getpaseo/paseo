import { useRetainedPanelActive } from "@/components/retained-panel";
import { useMemo } from "react";
import {
  Modal as NativeModal,
  Platform,
  useWindowDimensions,
  type ModalProps as NativeModalProps,
} from "react-native";
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
  const { visible: requestedVisible = true, onRequestClose, style } = props;
  const active = useRetainedPanelActive();
  const visible = requestedVisible && active;
  useDismissibleOverlay(visible && onRequestClose !== undefined, onRequestClose ?? noClose);
  const windowFrame = useAndroidWindowFrame();
  const containerStyle = useMemo(() => [windowFrame, style], [windowFrame, style]);
  // Hidden web chats freeze before a modal exit animation can finish.
  // Remove the portal while its owner is inactive.
  if (!active) return null;
  return (
    <NativeModal
      supportedOrientations={orientations}
      {...props}
      visible={visible}
      style={containerStyle}
    />
  );
}

/**
 * On Android, React Native lays out a modal's first frames at the screen size minus the status and
 * navigation bars, then grows it to the full window once the dialog reports its size. The app draws
 * edge-to-edge, so the dialog always covers the whole window: size the content to the window from
 * the first frame, or a full-screen backdrop stops short of the bottom and then snaps down.
 */
function useAndroidWindowFrame() {
  const { width, height } = useWindowDimensions();
  return useMemo(
    () => (Platform.OS === "android" ? { flex: 0, width, height } : null),
    [width, height],
  );
}
