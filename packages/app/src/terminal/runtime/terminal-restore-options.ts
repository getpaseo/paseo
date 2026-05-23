import type { SubscribeTerminalRequest } from "@server/shared/messages";

export const TERMINAL_VISIBLE_RESTORE_SCROLLBACK_LINES = 200;

export interface ResolveTerminalRestoreOptionsInput {
  supportsTerminalRestoreModes: boolean;
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
    ...(input.size ? { size: input.size } : {}),
  };
}
