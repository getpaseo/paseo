import { Keyboard, Pressable, type ViewProps } from "react-native";

/** Use behind scrollable content as a sibling, never as its responder ancestor. */
export function ComposerDockBackground(props: ViewProps) {
  return <Pressable {...props} accessible={false} onPress={Keyboard.dismiss} />;
}
