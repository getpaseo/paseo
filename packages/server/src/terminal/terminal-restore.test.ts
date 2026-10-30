import { describe, expect, test } from "vitest";

import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
} from "@getpaseo/protocol/binary-frames/index";
import {
  encodeTerminalRestoreFrame,
  resolveRestoreAfterOutputOverflow,
  resolveTerminalRestoreSnapshotOptions,
  resolveTerminalSubscriptionSnapshotMode,
} from "./terminal-restore.js";

describe("terminal restore policy", () => {
  test("uses ready snapshots only for restore-aware subscriptions", () => {
    expect(resolveTerminalSubscriptionSnapshotMode(undefined)).toBe("state");
    expect(resolveTerminalSubscriptionSnapshotMode({ mode: "live" })).toBe("ready");
  });

  test("resolves bounded restore snapshot options", () => {
    expect(resolveTerminalRestoreSnapshotOptions({ mode: "live" })).toBeNull();
    expect(resolveTerminalRestoreSnapshotOptions({ mode: "full-snapshot" })).toBeUndefined();
    expect(resolveTerminalRestoreSnapshotOptions({ mode: "visible-snapshot" })).toEqual({
      scrollbackLines: 200,
    });
    expect(
      resolveTerminalRestoreSnapshotOptions({
        mode: "visible-snapshot",
        scrollbackLines: 999,
      }),
    ).toEqual({ scrollbackLines: 500 });
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
        data: new TextEncoder().encode("restored"),
      }),
    );

    expect(frame?.opcode).toBe(TerminalStreamOpcode.Restore);
    expect(frame?.slot).toBe(4);
    expect(new TextDecoder().decode(frame?.payload ?? new Uint8Array())).toContain("restored");
  });
});
