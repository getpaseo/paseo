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

export function createNativeTerminalKeyEvent(key: NativeTerminalKey): NativeTerminalKeyEvent {
  return {
    key,
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
  };
}

export function forwardNativeTerminalKey(input: {
  key: NativeTerminalKey;
  onTerminalKey?: NativeTerminalKeyHandler;
}): void {
  input.onTerminalKey?.(createNativeTerminalKeyEvent(input.key));
}
