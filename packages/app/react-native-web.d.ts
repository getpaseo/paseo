import "react-native";

declare module "react-native" {
  interface PressableStateCallbackType {
    hovered?: boolean;
  }
  // The capture phase of `topTouchStart` (BaseViewConfig); RN's types list only the bubble one.
  interface ViewProps {
    onTouchStartCapture?: (event: GestureResponderEvent) => void;
  }
}
