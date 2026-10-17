import type { SubscribeTerminalRequest } from "@getpaseo/protocol/messages";

export interface ResolveTerminalRestoreOptionsInput {
  supportsTerminalRestoreModes: boolean;
  canClaimSize: boolean;
  size: { rows: number; cols: number } | null;
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
    scrollbackLines: input.scrollbackLines,
    ...(input.canClaimSize && input.size ? { size: input.size } : {}),
  };
}
