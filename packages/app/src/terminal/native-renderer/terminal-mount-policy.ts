export type NativeTerminalMountAction = "keep" | "mount";

export function resolveNativeTerminalMountAction(input: {
  mountedStreamKey: string | null;
  nextStreamKey: string;
}): NativeTerminalMountAction {
  return input.mountedStreamKey === input.nextStreamKey ? "keep" : "mount";
}
