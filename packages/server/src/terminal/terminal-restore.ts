import type {
  SubscribeTerminalRequest,
  TerminalCell,
  TerminalState,
} from "@getpaseo/protocol/messages";
import {
  TerminalStreamOpcode,
  encodeTerminalSnapshotPayload,
  encodeTerminalStreamFrame,
} from "@getpaseo/protocol/binary-frames/index";
import { renderTerminalSnapshotToAnsi } from "@getpaseo/protocol/terminal-snapshot";
import type { TerminalStateSnapshot, TerminalStateSnapshotOptions } from "./terminal.js";

export const MAX_TERMINAL_OUTPUT_FRAME_BYTES = 256 * 1024;

// A client is only forced onto the snapshot catch-up path once its transport is
// genuinely backed up — measured by the socket's bufferedAmount, not by how much
// the terminal has produced. Set well above any normal in-flight burst (a
// keeping-up client drains continuously and never approaches this) but low
// enough that a stalled socket crosses it long before a large burst finishes.
export const MAX_CLIENT_BUFFERED_BYTES = 4 * 1024 * 1024;

const DEFAULT_VISIBLE_RESTORE_SCROLLBACK_LINES = 200;
const MAX_VISIBLE_RESTORE_SCROLLBACK_LINES = 500;

export type TerminalRestoreOptions = NonNullable<SubscribeTerminalRequest["restore"]>;

export type TerminalSubscriptionSnapshotMode = "state" | "ready";

export function resolveTerminalSubscriptionSnapshotMode(
  restore: TerminalRestoreOptions | undefined,
): TerminalSubscriptionSnapshotMode {
  return restore ? "ready" : "state";
}

export function resolveRestoreAfterOutputOverflow(
  restore: TerminalRestoreOptions | undefined,
): TerminalRestoreOptions | undefined {
  if (restore?.mode === "live") {
    return { mode: "visible-snapshot" };
  }
  return restore;
}

export function resolveTerminalRestoreSnapshotOptions(
  restore: TerminalRestoreOptions,
): TerminalStateSnapshotOptions | null | undefined {
  if (restore.mode === "live") {
    return null;
  }
  if (restore.mode === "visible-snapshot") {
    return {
      scrollbackLines: resolveVisibleRestoreScrollbackLines(restore.scrollbackLines),
    };
  }
  return undefined;
}

export function encodeLegacyTerminalSnapshotFrame(input: {
  slot: number;
  snapshot: TerminalStateSnapshot;
}): Uint8Array {
  return encodeTerminalStreamFrame({
    opcode: TerminalStreamOpcode.Snapshot,
    slot: input.slot,
    payload: encodeTerminalSnapshotPayload(input.snapshot.state),
  });
}

export function encodeTerminalRestoreFrame(input: {
  slot: number;
  snapshot: TerminalStateSnapshot;
}): Uint8Array {
  return encodeTerminalStreamFrame({
    opcode: TerminalStreamOpcode.Restore,
    slot: input.slot,
    payload: renderTerminalSnapshotToAnsi(input.snapshot.state),
  });
}

// COMPAT(terminalUnicode11Widths): added in v0.11.3, remove after 2027-04-11.
// The wide ranges of xterm's Unicode 6 table (UnicodeV6 in @xterm/headless).
const UNICODE6_WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0x303e],
  [0x3040, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

function isUnicode6Wide(char: string): boolean {
  const codePoint = char.codePointAt(0) ?? 0;
  return UNICODE6_WIDE_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

function toUnicode6Row(row: TerminalCell[]): TerminalCell[] {
  if (!row.some((cell) => cell.char === "")) {
    return row;
  }
  return row.map((cell, index) =>
    cell.char === "" && !isUnicode6Wide(row[index - 1]?.char ?? "") ? { ...cell, char: " " } : cell,
  );
}

// A client with Unicode 6 widths moves an emoji only one column and skips its
// spacer cell, so the rest of the row lands one column left. Send the spacer
// as a space instead. Unicode 6 already counts CJK as two cells, so CJK spacers stay.
export function toUnicode6Widths(state: TerminalState): TerminalState {
  return {
    ...state,
    grid: state.grid.map(toUnicode6Row),
    scrollback: state.scrollback.map(toUnicode6Row),
  };
}

function resolveVisibleRestoreScrollbackLines(value: number | undefined): number {
  if (typeof value !== "number") {
    return DEFAULT_VISIBLE_RESTORE_SCROLLBACK_LINES;
  }
  return Math.min(Math.max(0, value), MAX_VISIBLE_RESTORE_SCROLLBACK_LINES);
}
