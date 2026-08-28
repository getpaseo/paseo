import { describe, expect, test } from "vitest";
import type { TFunction } from "i18next";
import { getTransferStatusText, type Transfer } from "./transfer-status";

// A pure function with the translator injected: no module mocks, no component mount.
const t = ((key: string) => key) as unknown as TFunction;

function transfer(overrides: Partial<Transfer>): Transfer {
  return {
    id: "t1",
    fileName: "file.bin",
    inFlight: true,
    complete: false,
    dismiss: () => {},
    ...overrides,
  };
}

describe("getTransferStatusText", () => {
  test("reports percent, speed and ETA when the total is known", () => {
    const text = getTransferStatusText(
      transfer({
        progress: {
          percent: 0.42,
          bytesWritten: 42 * 1024 * 1024,
          totalBytes: 100 * 1024 * 1024,
          speed: 2 * 1024 * 1024,
          eta: 29,
        },
      }),
      false,
      t,
    );
    expect(text).toBe("42% · 2.0 MB/s · 29s");
  });

  test("reports transferred bytes and speed when the total is unknown", () => {
    // A streamed archive: percent would sit at 0 and ETA at "< 1s" for the whole transfer.
    const text = getTransferStatusText(
      transfer({
        progress: {
          percent: 0,
          bytesWritten: 12 * 1024 * 1024,
          totalBytes: 0,
          speed: 3 * 1024 * 1024,
          eta: 0,
        },
      }),
      false,
      t,
    );
    expect(text).toBe("12.0 MB · 3.0 MB/s");
    expect(text).not.toContain("0%");
    expect(text).not.toContain("< 1s");
  });

  test("falls back to a starting label before any progress arrives", () => {
    expect(getTransferStatusText(transfer({}), false, t)).toBe("common.states.starting");
  });

  test("distinguishes upload and download completion", () => {
    const done = { inFlight: false, complete: true };
    expect(getTransferStatusText(transfer(done), true, t)).toBe("common.states.uploadComplete");
    expect(getTransferStatusText(transfer(done), false, t)).toBe("common.states.downloadComplete");
  });

  test("prefers the transfer's own error over the generic one", () => {
    const failed = {
      inFlight: false,
      complete: false,
      message: "The host cancelled this transfer.",
    };
    expect(getTransferStatusText(transfer(failed), false, t)).toBe(
      "The host cancelled this transfer.",
    );
    expect(getTransferStatusText(transfer({ inFlight: false, complete: false }), true, t)).toBe(
      "common.states.uploadFailed",
    );
  });
});
