import stripAnsi from "strip-ansi";
import type { TerminalCell } from "../shared/messages.js";
import type { TerminalSession } from "./terminal.js";

export interface CaptureTerminalLinesOptions {
  start?: number;
  end?: number;
  stripAnsi?: boolean;
}

export interface CaptureTerminalLinesResult {
  lines: string[];
  totalLines: number;
}

function cellsToPlainText(cells: TerminalCell[], options: { stripAnsi: boolean }): string {
  const text = cells
    .map((cell) => cell.char)
    .join("")
    .trimEnd();
  return options.stripAnsi ? stripAnsi(text) : text;
}

function resolveCaptureLineIndex(
  lineNumber: number | undefined,
  totalLines: number,
  fallback: "start" | "end",
): number {
  if (totalLines === 0) {
    return fallback === "start" ? 0 : -1;
  }

  const defaultIndex = fallback === "start" ? 0 : totalLines - 1;
  if (typeof lineNumber !== "number") {
    return defaultIndex;
  }

  const resolvedIndex = lineNumber < 0 ? totalLines + lineNumber : lineNumber;
  if (resolvedIndex < 0) {
    return 0;
  }
  if (resolvedIndex >= totalLines) {
    return totalLines - 1;
  }
  return resolvedIndex;
}

export function captureTerminalLines(
  terminal: TerminalSession,
  options: CaptureTerminalLinesOptions = {},
): CaptureTerminalLinesResult {
  const state = terminal.getState();
  const allLines = [...state.scrollback, ...state.grid].map((cells) =>
    cellsToPlainText(cells, { stripAnsi: options.stripAnsi ?? true }),
  );
  const totalLines = allLines.length;
  const startIndex = resolveCaptureLineIndex(options.start, totalLines, "start");
  const endIndex = resolveCaptureLineIndex(options.end, totalLines, "end");

  if (totalLines === 0 || startIndex > endIndex) {
    return {
      lines: [],
      totalLines,
    };
  }

  return {
    lines: allLines.slice(startIndex, endIndex + 1),
    totalLines,
  };
}
