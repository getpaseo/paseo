import type { KeyboardInputEvent, MouseInputEvent, MouseWheelInputEvent } from "electron";
import type { InputModifier } from "@getpaseo/server/browser-tools/cdp-input";

export interface IsolatedKeyboardInputEvent extends KeyboardInputEvent {
  type: "char" | "keyDown" | "keyUp";
  // Electron accepts this NativeWebKeyboardEvent flag even though its public
  // TypeScript declarations omit it. It stops an unhandled webview key from
  // being redispatched to the embedder's active DOM element or application menu.
  skipIfUnhandled: true;
}

export type BrowserInputEvent = IsolatedKeyboardInputEvent | MouseInputEvent | MouseWheelInputEvent;

type KeyboardInputSender = (event: IsolatedKeyboardInputEvent) => void;

const ELECTRON_MODIFIERS: Record<
  InputModifier,
  NonNullable<KeyboardInputEvent["modifiers"]>[number]
> = {
  Alt: "alt",
  Control: "control",
  Meta: "meta",
  Shift: "shift",
};

const ELECTRON_KEY_CODE_ALIASES: Record<string, string> = {
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
};

export function dispatchTrustedKey(
  send: KeyboardInputSender,
  key: string,
  modifiers: InputModifier[] = [],
): void {
  const keyCode = ELECTRON_KEY_CODE_ALIASES[key] ?? key;
  const electronModifiers = electronInputModifiers(modifiers);
  const modifierFields = electronModifiers.length > 0 ? { modifiers: electronModifiers } : {};
  let character: string | null = null;
  if (key === "Space") {
    character = " ";
  } else if (key.length === 1) {
    character = key;
  }
  send({
    type: "keyDown",
    keyCode,
    skipIfUnhandled: true,
    ...modifierFields,
  });
  if (character !== null) {
    send({
      type: "char",
      keyCode: character,
      skipIfUnhandled: true,
      ...modifierFields,
    });
  }
  send({
    type: "keyUp",
    keyCode,
    skipIfUnhandled: true,
    ...modifierFields,
  });
}

function electronInputModifiers(
  modifiers: InputModifier[],
): NonNullable<KeyboardInputEvent["modifiers"]> {
  return modifiers.map((modifier) => ELECTRON_MODIFIERS[modifier]);
}
