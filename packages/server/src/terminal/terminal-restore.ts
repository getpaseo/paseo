import type { z } from "zod";
import type { SubscribeTerminalRequest } from "@getpaseo/protocol/messages";
import {
  TerminalStreamOpcode,
  type TerminalReplayMetadataSchema,
  encodeTerminalStreamFrame,
} from "@getpaseo/protocol/binary-frames/index";
import type { TerminalReplaySink, TerminalReplayOptions } from "./terminal-replay.js";

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

export function resolveRestoreAfterOutputOverflow(
  restore: TerminalRestoreOptions | undefined,
): TerminalRestoreOptions {
  return {
    mode: "visible-snapshot",
    scrollbackLines: Math.min(
      restore?.scrollbackLines ?? MAX_VISIBLE_RESTORE_SCROLLBACK_LINES,
      MAX_VISIBLE_RESTORE_SCROLLBACK_LINES,
    ),
  };
}

export function resolveTerminalRestoreSnapshotOptions({
  restore,
  chunked,
}: {
  restore: TerminalRestoreOptions;
  chunked: boolean;
}): TerminalReplayOptions | null | undefined {
  if (restore.mode === "live") {
    return null;
  }
  if (restore.mode === "full-snapshot") {
    return chunked ? { scrollbackLines: restore.scrollbackLines } : undefined;
  }
  const scrollbackLines = restore.scrollbackLines ?? DEFAULT_VISIBLE_RESTORE_SCROLLBACK_LINES;
  return {
    scrollbackLines: chunked
      ? scrollbackLines
      : Math.min(scrollbackLines, MAX_VISIBLE_RESTORE_SCROLLBACK_LINES),
  };
}

export function encodeTerminalRestoreFrame(input: { slot: number; data: Uint8Array }): Uint8Array {
  return encodeTerminalStreamFrame({
    opcode: TerminalStreamOpcode.Restore,
    slot: input.slot,
    payload: input.data,
  });
}

/** The daemon's only old-app adapter. Capable delivery never assembles the replay. */
export function createTerminalRestoreDelivery(input: {
  slot: number;
  chunked: boolean;
  send(frame: Uint8Array): void;
}): TerminalReplaySink {
  // COMPAT(terminalSingleRestore): added after v0.14.0; remove after 2027-04-30 when client floor supports chunked replay.
  const legacyChunks: Uint8Array[] = [];
  return (event) => {
    if (!input.chunked) {
      if (event.type === "data") legacyChunks.push(event.data);
      if (event.type === "end")
        input.send(
          encodeTerminalRestoreFrame({
            slot: input.slot,
            data: Buffer.concat(legacyChunks),
          }),
        );
      return;
    }
    const opcodes = {
      begin: TerminalStreamOpcode.ReplayBegin,
      data: TerminalStreamOpcode.ReplayData,
      end: TerminalStreamOpcode.ReplayEnd,
    };
    let payload: string | Uint8Array | undefined;
    if (event.type === "begin") {
      const begin = {
        rows: event.metadata.rows,
        cols: event.metadata.cols,
        retainedHistoryLines: event.metadata.retainedHistoryLines,
      } satisfies z.infer<typeof TerminalReplayMetadataSchema>;
      payload = JSON.stringify(begin);
    }
    if (event.type === "data") payload = event.data;
    input.send(
      encodeTerminalStreamFrame({ slot: input.slot, opcode: opcodes[event.type], payload }),
    );
  };
}
