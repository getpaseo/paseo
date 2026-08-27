import type { SubscribeTerminalRequest } from "@getpaseo/protocol/messages";

export const TERMINAL_VISIBLE_RESTORE_SCROLLBACK_LINES = 200;

export interface ResolveTerminalRestoreOptionsInput {
  supportsTerminalRestoreModes: boolean;
  canClaimSize: boolean;
  size: { rows: number; cols: number } | null;
}

export function resolveTerminalRestoreOptions(
  input: ResolveTerminalRestoreOptionsInput,
): SubscribeTerminalRequest["restore"] | undefined {
  if (!input.supportsTerminalRestoreModes) {
    return undefined;
  }

  return {
    mode: "visible-snapshot",
    scrollbackLines: TERMINAL_VISIBLE_RESTORE_SCROLLBACK_LINES,
    ...(input.canClaimSize && input.size ? { size: input.size } : {}),
  };
}
