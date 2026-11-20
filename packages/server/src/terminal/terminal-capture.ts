import stripAnsi from "strip-ansi";
import type { IBuffer } from "@xterm/headless";

export interface CaptureTerminalLinesOptions {
  start?: number;
  end?: number;
  stripAnsi?: boolean;
}

export interface CaptureTerminalLinesResult {
  lines: string[];
  totalLines: number;
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
  buffer: IBuffer,
  options: CaptureTerminalLinesOptions = {},
): CaptureTerminalLinesResult {
  const totalLines = buffer.length;
  const startIndex = resolveCaptureLineIndex(options.start, totalLines, "start");
  const endIndex = resolveCaptureLineIndex(options.end, totalLines, "end");

  if (totalLines === 0 || startIndex > endIndex) {
    return {
      lines: [],
      totalLines,
    };
  }

  const lines: string[] = [];
  for (let row = startIndex; row <= endIndex; row++) {
    const text = buffer.getLine(row)!.translateToString(true).trimEnd();
    lines.push(options.stripAnsi === false ? text : stripAnsi(text));
  }
  return { lines, totalLines };
}
