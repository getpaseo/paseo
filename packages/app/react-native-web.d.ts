import "react-native";

declare module "react-native" {
  interface PressableStateCallbackType {
    hovered?: boolean;
  }
}
