export type NativeTerminalSizeClaimAction = "focus" | "key" | "paste" | "showKeyboard" | "text";

export function shouldClaimNativeTerminalSize(action: NativeTerminalSizeClaimAction): boolean {
  return action !== "text" && action !== "key";
}
