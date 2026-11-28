import { resolveKeyboardFocusScope } from "../focus-scope";

export function registerFocusedTextInput(): () => void {
  return () => {};
}

export function hasFocusedTextInput(): boolean {
  const scope = resolveKeyboardFocusScope({ target: null, commandCenterOpen: false });
  return scope === "editable" || scope === "message-input";
}
