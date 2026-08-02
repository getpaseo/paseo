export type NativeTerminalSizeClaimAction =
  | "focus"
  | "key"
  | "paste"
  | "resizeRequest"
  | "showKeyboard"
  | "text";

export function shouldClaimNativeTerminalSize(action: NativeTerminalSizeClaimAction): boolean {
  return action !== "text" && action !== "key";
}
