import type { Theme } from "@/styles/theme";
import { hexColorWithAlpha } from "@/utils/color";
import type { DiffCell, DiffPalette } from "./types";

export function createDiffPalette(theme: Theme): DiffPalette {
  return {
    surface: theme.colors.surface0,
    headerSurface: theme.colors.surface0,
    border: theme.colors.border,
    foreground: theme.colors.foreground,
    foregroundMuted: theme.colors.foregroundMuted,
    addition: theme.colors.statusSuccess,
    deletion: theme.colors.statusDanger,
    additionBackground: hexColorWithAlpha(theme.colors.statusSuccess, 0.15),
    deletionBackground: hexColorWithAlpha(theme.colors.statusDanger, 0.1),
    emptyBackground: theme.colors.surface0,
    selection: theme.colors.terminal.blue,
    syntax: theme.colors.syntax,
  };
}

export function retainDiffPalette(previous: DiffPalette, next: DiffPalette): DiffPalette {
  if (
    previous.surface !== next.surface ||
    previous.headerSurface !== next.headerSurface ||
    previous.border !== next.border ||
    previous.foreground !== next.foreground ||
    previous.foregroundMuted !== next.foregroundMuted ||
    previous.addition !== next.addition ||
    previous.deletion !== next.deletion ||
    previous.additionBackground !== next.additionBackground ||
    previous.deletionBackground !== next.deletionBackground ||
    previous.emptyBackground !== next.emptyBackground ||
    previous.selection !== next.selection ||
    !sameColorMap(previous.syntax, next.syntax)
  ) {
    return next;
  }
  return previous;
}

function sameColorMap(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}

export function codeTextColor(cell: DiffCell, palette: DiffPalette): string {
  return cell.type === "header" ? palette.foregroundMuted : palette.foreground;
}

export function codeLineNumberTone(cell: DiffCell): "addition" | "deletion" | "foregroundMuted" {
  "worklet";
  if (cell.type === "add") return "addition";
  if (cell.type === "remove") return "deletion";
  return "foregroundMuted";
}
