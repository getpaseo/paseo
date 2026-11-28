// oxlint-disable-next-line no-restricted-imports -- Keyboard boundary reads focus state; it does not render an input.
import { TextInput } from "react-native";
import { hasRegisteredFocusedTextInput } from "./native-focused-input";

export { registerFocusedTextInput } from "./native-focused-input";

export function hasFocusedTextInput(): boolean {
  return (
    hasRegisteredFocusedTextInput() || (TextInput.State?.currentlyFocusedInput?.() ?? null) !== null
  );
}
