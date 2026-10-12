import { describe, expect, it } from "vitest";

import { resolveTerminalRestoreOptions } from "./terminal-restore-options";

const capableInput = {
  supportsTerminalRestoreModes: true,
  canClaimSize: true,
  size: { rows: 24, cols: 80 },
  scrollbackLines: 5000,
};

describe("terminal restore options", () => {
  it("omits restore options for daemons without terminal restore modes", () => {
    expect(
      resolveTerminalRestoreOptions({ ...capableInput, supportsTerminalRestoreModes: false }),
    ).toBeUndefined();
  });

  it("requests the pane's configured scrollback rather than a fixed window", () => {
    // Restoring fewer lines than the terminal holds drops history that no later
    // attach can recover, so the request has to track the setting.
    expect(resolveTerminalRestoreOptions(capableInput)).toEqual({
      mode: "visible-snapshot",
      scrollbackLines: 5000,
      size: { rows: 24, cols: 80 },
    });
  });

  it("omits size until the terminal has been measured", () => {
    expect(resolveTerminalRestoreOptions({ ...capableInput, size: null })).toEqual({
      mode: "visible-snapshot",
      scrollbackLines: 5000,
    });
  });

  it("does not let a background attach resize the PTY", () => {
    expect(resolveTerminalRestoreOptions({ ...capableInput, canClaimSize: false })).toEqual({
      mode: "visible-snapshot",
      scrollbackLines: 5000,
    });
  });

  it("normalizes the configured scrollback to a whole non-negative line count", () => {
    expect(
      resolveTerminalRestoreOptions({ ...capableInput, scrollbackLines: 1199.6 }),
    ).toMatchObject({ scrollbackLines: 1199 });
    expect(resolveTerminalRestoreOptions({ ...capableInput, scrollbackLines: -5 })).toMatchObject({
      scrollbackLines: 0,
    });
  });
});
