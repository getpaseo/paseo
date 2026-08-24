import { describe, expect, it } from "vitest";

import { resolveTerminalRestoreOptions } from "./terminal-restore-options";

describe("terminal restore options", () => {
  it("omits restore options for daemons without terminal restore modes", () => {
    expect(
      resolveTerminalRestoreOptions({
        supportsTerminalRestoreModes: false,
        canClaimSize: true,
        size: { rows: 24, cols: 80 },
      }),
    ).toBeUndefined();
  });

  it("requests visible snapshot restore with bounded scrollback for capable daemons", () => {
    expect(
      resolveTerminalRestoreOptions({
        supportsTerminalRestoreModes: true,
        canClaimSize: true,
        size: { rows: 24, cols: 80 },
      }),
    ).toEqual({
      mode: "visible-snapshot",
      scrollbackLines: 200,
      size: { rows: 24, cols: 80 },
    });
  });

  it("omits size until the terminal has been measured", () => {
    expect(
      resolveTerminalRestoreOptions({
        supportsTerminalRestoreModes: true,
        canClaimSize: true,
        size: null,
      }),
    ).toEqual({
      mode: "visible-snapshot",
      scrollbackLines: 200,
    });
  });

  it("does not let a background attach resize the PTY", () => {
    expect(
      resolveTerminalRestoreOptions({
        supportsTerminalRestoreModes: true,
        canClaimSize: false,
        size: { rows: 24, cols: 80 },
      }),
    ).toEqual({
      mode: "visible-snapshot",
      scrollbackLines: 200,
    });
  });
});
