import type { SubscribeTerminalRequest } from "../server/messages.js";
import {
  TerminalStreamOpcode,
  encodeTerminalSnapshotPayload,
  encodeTerminalStreamFrame,
} from "../shared/binary-frames/index.js";
import { renderTerminalSnapshotToAnsi } from "../shared/terminal-snapshot.js";
import type { TerminalStateSnapshot, TerminalStateSnapshotOptions } from "./terminal.js";

export const MAX_TERMINAL_OUTPUT_FRAME_BYTES = 256 * 1024;

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

function resolveVisibleRestoreScrollbackLines(value: number | undefined): number {
  if (typeof value !== "number") {
    return DEFAULT_VISIBLE_RESTORE_SCROLLBACK_LINES;
  }
  return Math.min(Math.max(0, value), MAX_VISIBLE_RESTORE_SCROLLBACK_LINES);
}
