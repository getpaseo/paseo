// oxlint-disable-next-line no-restricted-imports -- Keyboard boundary reads focus state; it does not render an input.
import { TextInput } from "react-native";

export function hasFocusedTextInput(): boolean {
  return TextInput.State.currentlyFocusedInput() !== null;
}
