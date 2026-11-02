import { describe, expect, test } from "vitest";

import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
} from "@getpaseo/protocol/binary-frames/index";
import {
  createTerminalRestoreDelivery,
  encodeTerminalRestoreFrame,
  resolveRestoreAfterOutputOverflow,
  resolveTerminalRestoreSnapshotOptions,
} from "./terminal-restore.js";

describe("terminal restore policy", () => {
  test("resolves bounded restore snapshot options", () => {
    expect(
      resolveTerminalRestoreSnapshotOptions({ restore: { mode: "live" }, chunked: false }),
    ).toBeNull();
    expect(
      resolveTerminalRestoreSnapshotOptions({ restore: { mode: "full-snapshot" }, chunked: false }),
    ).toBeUndefined();
    expect(
      resolveTerminalRestoreSnapshotOptions({
        restore: { mode: "visible-snapshot" },
        chunked: false,
      }),
    ).toEqual({
      scrollbackLines: 200,
    });
    expect(
      resolveTerminalRestoreSnapshotOptions({
        restore: { mode: "visible-snapshot", scrollbackLines: 999 },
        chunked: false,
      }),
    ).toEqual({ scrollbackLines: 500 });
  });

  test("bounds pressure recovery for every restore mode", () => {
    expect(resolveRestoreAfterOutputOverflow({ mode: "live" })).toEqual({
      mode: "visible-snapshot",
      scrollbackLines: 500,
    });
    expect(resolveRestoreAfterOutputOverflow({ mode: "full-snapshot" })).toEqual({
      mode: "visible-snapshot",
      scrollbackLines: 500,
    });
  });

  test("encodes restore snapshots as restore frames", () => {
    const frame = decodeTerminalStreamFrame(
      encodeTerminalRestoreFrame({
        slot: 4,
        data: new TextEncoder().encode("restored"),
      }),
    );

    expect(frame?.opcode).toBe(TerminalStreamOpcode.Restore);
    expect(frame?.slot).toBe(4);
    expect(new TextDecoder().decode(frame?.payload ?? new Uint8Array())).toContain("restored");
  });
});

test("projects chunked replay begin onto the declared wire metadata", () => {
  const frames: Uint8Array[] = [];
  const deliver = createTerminalRestoreDelivery({
    slot: 7,
    chunked: true,
    send: (frame) => {
      frames.push(frame);
    },
  });
  deliver({
    type: "begin",
    metadata: {
      rows: 30,
      cols: 120,
      retainedHistoryLines: 842,
      revision: 5123,
      replayPreamble: "\x1b[?2004h",
    },
  });
  const data = new TextEncoder().encode("\x1b[31m界 replay\x1b[0m");
  deliver({ type: "data", data });
  deliver({ type: "end" });
  const decoded = frames.map((frame) => decodeTerminalStreamFrame(frame)!);
  expect(decoded.map((frame) => ({ slot: frame.slot, opcode: frame.opcode }))).toEqual([
    { slot: 7, opcode: TerminalStreamOpcode.ReplayBegin },
    { slot: 7, opcode: TerminalStreamOpcode.ReplayData },
    { slot: 7, opcode: TerminalStreamOpcode.ReplayEnd },
  ]);
  expect(JSON.parse(new TextDecoder().decode(decoded[0]!.payload))).toEqual({
    rows: 30,
    cols: 120,
    retainedHistoryLines: 842,
  });
  expect(decoded[1]!.payload).toEqual(data);
  expect(decoded[2]!.payload.byteLength).toBe(0);
});
