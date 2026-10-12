import { describe, expect, test } from "vitest";

import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
} from "@getpaseo/protocol/binary-frames/index";
import type { TerminalCell, TerminalState } from "@getpaseo/protocol/messages";
import {
  encodeTerminalRestoreFrame,
  resolveRestoreAfterOutputOverflow,
  resolveTerminalRestoreSnapshotOptions,
  resolveTerminalSubscriptionSnapshotMode,
} from "./terminal-restore.js";
import { TERMINAL_MODEL_SCROLLBACK_LINES } from "./terminal-model-limits.js";

function terminalRow(text: string, cols = 80): TerminalCell[] {
  return Array.from({ length: cols }, (_, index) => ({
    char: text[index] ?? " ",
  }));
}

function terminalState(text: string): TerminalState {
  return {
    rows: 1,
    cols: 80,
    grid: [terminalRow(text)],
    scrollback: [],
    cursor: { row: 0, col: text.length },
  };
}

describe("terminal restore policy", () => {
  test("uses ready snapshots only for restore-aware subscriptions", () => {
    expect(resolveTerminalSubscriptionSnapshotMode(undefined)).toBe("state");
    expect(resolveTerminalSubscriptionSnapshotMode({ mode: "live" })).toBe("ready");
  });

  test("resolves restore snapshot options bounded by the daemon's own window", () => {
    expect(resolveTerminalRestoreSnapshotOptions({ mode: "live" })).toBeNull();
    expect(resolveTerminalRestoreSnapshotOptions({ mode: "full-snapshot" })).toBeUndefined();
    expect(resolveTerminalRestoreSnapshotOptions({ mode: "visible-snapshot" })).toEqual({
      scrollbackLines: 200,
    });
    // A client asking for its configured scrollback gets what it asks for, right
    // up to the rows the model actually keeps.
    expect(
      resolveTerminalRestoreSnapshotOptions({
        mode: "visible-snapshot",
        scrollbackLines: TERMINAL_MODEL_SCROLLBACK_LINES - 1,
      }),
    ).toEqual({ scrollbackLines: TERMINAL_MODEL_SCROLLBACK_LINES - 1 });
    expect(
      resolveTerminalRestoreSnapshotOptions({
        mode: "visible-snapshot",
        scrollbackLines: TERMINAL_MODEL_SCROLLBACK_LINES * 10,
      }),
    ).toEqual({ scrollbackLines: TERMINAL_MODEL_SCROLLBACK_LINES });
  });

  test("promotes live restore to visible restore after output overflow", () => {
    expect(resolveRestoreAfterOutputOverflow({ mode: "live" })).toEqual({
      mode: "visible-snapshot",
    });
    expect(resolveRestoreAfterOutputOverflow({ mode: "full-snapshot" })).toEqual({
      mode: "full-snapshot",
    });
  });

  test("encodes restore snapshots as restore frames", () => {
    const frame = decodeTerminalStreamFrame(
      encodeTerminalRestoreFrame({
        slot: 4,
        snapshot: {
          state: terminalState("restored"),
          revision: 1,
        },
      }),
    );

    expect(frame?.opcode).toBe(TerminalStreamOpcode.Restore);
    expect(frame?.slot).toBe(4);
    expect(new TextDecoder().decode(frame?.payload ?? new Uint8Array())).toContain("restored");
  });

  test("sends ANSI the terminal already rendered without reading the cells", () => {
    const frame = decodeTerminalStreamFrame(
      encodeTerminalRestoreFrame({
        slot: 4,
        snapshot: {
          state: terminalState(""),
          revision: 1,
          ansi: "pre-rendered",
        },
      }),
    );

    expect(new TextDecoder().decode(frame?.payload ?? new Uint8Array())).toBe("pre-rendered");
  });
});
