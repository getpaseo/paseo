import { i18n } from "@/i18n/i18next";
import type { SubscribeTerminalRequest } from "@getpaseo/protocol/messages";

export interface ResolveTerminalRestoreOptionsInput {
  supportsTerminalRestoreModes: boolean;
  scrollbackLines: number;
  canClaimSize: boolean;
  size: { rows: number; cols: number } | null;
}

export function resolveTerminalRestoreOptions(
  input: ResolveTerminalRestoreOptionsInput,
): NonNullable<SubscribeTerminalRequest["restore"]> {
  if (!input.supportsTerminalRestoreModes) {
    throw new Error(i18n.t("workspace.terminal.restoreRequiresUpdate"));
  }

  return {
    mode: "visible-snapshot",
    scrollbackLines: input.scrollbackLines,
    ...(input.canClaimSize && input.size ? { size: input.size } : {}),
  };
}
