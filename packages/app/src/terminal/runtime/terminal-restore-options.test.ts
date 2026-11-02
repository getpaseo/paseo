import { describe, expect, it } from "vitest";

import { resolveTerminalRestoreOptions } from "./terminal-restore-options";

describe("terminal restore options", () => {
  it("omits restore options for daemons without terminal restore modes", () => {
    expect(() =>
      resolveTerminalRestoreOptions({
        scrollbackLines: 10000,
        supportsTerminalRestoreModes: false,
        canClaimSize: true,
        size: { rows: 24, cols: 80 },
      }),
    ).toThrow("Update the host to view terminals.");
  });

  it("requests visible snapshot restore with configured scrollback for capable daemons", () => {
    expect(
      resolveTerminalRestoreOptions({
        scrollbackLines: 10000,
        supportsTerminalRestoreModes: true,
        canClaimSize: true,
        size: { rows: 24, cols: 80 },
      }),
    ).toEqual({
      mode: "visible-snapshot",
      scrollbackLines: 10000,
      size: { rows: 24, cols: 80 },
    });
  });

  it("omits size until the terminal has been measured", () => {
    expect(
      resolveTerminalRestoreOptions({
        scrollbackLines: 10000,
        supportsTerminalRestoreModes: true,
        canClaimSize: true,
        size: null,
      }),
    ).toEqual({
      mode: "visible-snapshot",
      scrollbackLines: 10000,
    });
  });

  it("does not let a background attach resize the PTY", () => {
    expect(
      resolveTerminalRestoreOptions({
        scrollbackLines: 10000,
        supportsTerminalRestoreModes: true,
        canClaimSize: false,
        size: { rows: 24, cols: 80 },
      }),
    ).toEqual({
      mode: "visible-snapshot",
      scrollbackLines: 10000,
    });
  });
});

it.each([0, 5, 400, 10000])("requests exactly %s configured history rows", (scrollbackLines) => {
  expect(
    resolveTerminalRestoreOptions({
      supportsTerminalRestoreModes: true,
      scrollbackLines,
      canClaimSize: false,
      size: null,
    }),
  ).toEqual({ mode: "visible-snapshot", scrollbackLines });
});
