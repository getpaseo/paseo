import type { SubscribeTerminalRequest } from "@getpaseo/protocol/messages";

// Match the server cap in terminal-restore.ts: the daemon keeps 1000 lines of scrollback
// but clamps the restore request to MAX_VISIBLE_RESTORE_SCROLLBACK_LINES (500), so asking
// for more is pointless while asking for 200 silently dropped 300 lines on every reconnect.
export const TERMINAL_VISIBLE_RESTORE_SCROLLBACK_LINES = 500;

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
