import { resolveKeyboardFocusScope } from "../focus-scope";

export function hasFocusedTextInput(): boolean {
  const scope = resolveKeyboardFocusScope({ target: null, commandCenterOpen: false });
  return scope === "editable" || scope === "message-input";
}
