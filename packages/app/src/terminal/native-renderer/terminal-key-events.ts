export type NativeTerminalKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

export interface NativeTerminalKeyEvent {
  key: NativeTerminalKey;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

export type NativeTerminalKeyHandler = (event: NativeTerminalKeyEvent) => Promise<void> | void;

export function resolveNativeTerminalKey(key: string): NativeTerminalKey | null {
  switch (key) {
    case "ArrowUp":
    case "ArrowDown":
    case "ArrowLeft":
    case "ArrowRight":
      return key;
    default:
      return null;
  }
}

/**
 * Physical keyboards report the DOM `code`. UIKit leaves `key` as a sentinel
 * for Left/Right, so the code is the only reliable identifier there.
 */
export function resolveHardwareTerminalKey(input: {
  key?: string;
  code?: string;
}): NativeTerminalKey | null {
  return resolveNativeTerminalKey(input.code ?? "") ?? resolveNativeTerminalKey(input.key ?? "");
}

export function createNativeTerminalKeyEvent(
  key: NativeTerminalKey,
  modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {},
): NativeTerminalKeyEvent {
  return {
    key,
    ctrl: modifiers.ctrl ?? false,
    shift: modifiers.shift ?? false,
    alt: modifiers.alt ?? false,
    meta: modifiers.meta ?? false,
  };
}
