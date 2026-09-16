import { Keyboard, Pressable, type ViewProps } from "react-native";

/** Child controls and scroll views claim their own touches before this background. */
export function ComposerDockBackground(props: ViewProps) {
  return <Pressable {...props} accessible={false} onPress={Keyboard.dismiss} />;
}
