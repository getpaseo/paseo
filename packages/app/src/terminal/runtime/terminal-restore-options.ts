import type { SubscribeTerminalRequest } from "@getpaseo/protocol/messages";

export interface ResolveTerminalRestoreOptionsInput {
  supportsTerminalRestoreModes: boolean;
  canClaimSize: boolean;
  size: { rows: number; cols: number } | null;
  // The pane's configured scrollback. A restore that asks for fewer lines than
  // the terminal holds drops that history for good: the daemon only sends what an
  // attach asks for, and once those rows fall out of its own window no later
  // attach can hand them back.
  scrollbackLines: number;
}

export function resolveTerminalRestoreOptions(
  input: ResolveTerminalRestoreOptionsInput,
): SubscribeTerminalRequest["restore"] | undefined {
  if (!input.supportsTerminalRestoreModes) {
    return undefined;
  }

  return {
    mode: "visible-snapshot",
    scrollbackLines: Math.max(0, Math.floor(input.scrollbackLines)),
    ...(input.canClaimSize && input.size ? { size: input.size } : {}),
  };
}
