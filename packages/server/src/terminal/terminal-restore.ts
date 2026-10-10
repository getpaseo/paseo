import type { SubscribeTerminalRequest } from "@getpaseo/protocol/messages";
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
// The retention every terminal had before `daemon.terminalScrollbackLines`. A
// catch-up restore is resent as often as every MAX_TERMINAL_OUTPUT_FRAME_BYTES of
// output and a legacy snapshot ships cells, so both stay at this size however
// much the daemon retains.
export const LEGACY_SCROLLBACK_LINES = 1000;

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
  if (!restore) {
    return restore;
  }
  if (restore.mode === "live") {
    return { mode: "visible-snapshot" };
  }
  const requested =
    restore.mode === "full-snapshot"
      ? LEGACY_SCROLLBACK_LINES
      : resolveVisibleRestoreScrollbackLines(restore.scrollbackLines);
  return {
    ...restore,
    mode: "visible-snapshot",
    scrollbackLines: Math.min(requested, LEGACY_SCROLLBACK_LINES),
  };
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
    payload: input.snapshot.ansi ?? renderTerminalSnapshotToAnsi(input.snapshot.state),
  });
}

function resolveVisibleRestoreScrollbackLines(value: number | undefined): number {
  if (typeof value !== "number") {
    return DEFAULT_VISIBLE_RESTORE_SCROLLBACK_LINES;
  }
  return Math.max(0, value);
}
