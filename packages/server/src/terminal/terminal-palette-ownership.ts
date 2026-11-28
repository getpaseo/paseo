import type { TerminalDefaultColors } from "@getpaseo/protocol/messages";
import type { TerminalSession } from "./terminal.js";
import { resolveTerminalPalette, terminalPalettesEqual } from "./terminal-palette.js";

export interface TerminalPaletteRequest {
  defaultColors: TerminalDefaultColors;
  intent?: "claim" | "update";
}

const terminalPaletteOwners = new WeakMap<TerminalSession, WeakRef<object>>();

export function claimInitialTerminalPaletteOwner(terminal: TerminalSession, owner: object): void {
  terminalPaletteOwners.set(terminal, new WeakRef(owner));
}

export function applyTerminalPalette(
  terminal: TerminalSession,
  owner: object,
  request: TerminalPaletteRequest,
): boolean {
  const intent = request.intent ?? "claim";
  if (intent === "update" && terminalPaletteOwners.get(terminal)?.deref() !== owner) {
    return false;
  }

  if (intent === "claim") {
    terminalPaletteOwners.set(terminal, new WeakRef(owner));
  }

  const nextPalette = resolveTerminalPalette(request.defaultColors);
  const currentColors = terminal.getDefaultColors?.();
  const currentPalette = resolveTerminalPalette(currentColors);
  if (!terminalPalettesEqual(currentPalette, nextPalette)) {
    terminal.send({ type: "palette", defaultColors: request.defaultColors });
  }
  return true;
}
