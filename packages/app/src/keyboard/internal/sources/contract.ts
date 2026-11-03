import type { KeyboardFocusScope } from "../../actions";
import type { KeyboardInputEvent } from "../overlays";
export interface KeyboardSourceInput {
  event: KeyboardInputEvent;
  focusScope: KeyboardFocusScope;
  captureFocusRestore(): void;
}
export interface KeyboardSourceHandlers {
  keyDown(input: KeyboardSourceInput): void;
  keyUp(event: KeyboardInputEvent): void;
  blur(): void;
  commandCenterOpen(): boolean;
}
export function nativeKeyboardInput(
  event: KeyboardInputEvent,
  focusScope: KeyboardFocusScope,
): KeyboardSourceInput {
  return { event, focusScope, captureFocusRestore() {} };
}

import type { ChordState, ParsedShortcutBinding } from "../../keyboard-shortcuts";
export interface KeyboardPolicyInput {
  bindings: readonly ParsedShortcutBinding[];
  chordState?: ChordState;
  isMac: boolean;
  enabled: boolean;
}
