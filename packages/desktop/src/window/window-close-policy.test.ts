import { describe, expect, it } from "vitest";

import { countLiveWindows, shouldVetoWindowClose } from "./window-close-policy.js";

function win(destroyed = false) {
  return { isDestroyed: () => destroyed };
}

const OPEN = { quitCommitted: false, sessionEnding: false };

describe("countLiveWindows", () => {
  it("ignores destroyed windows", () => {
    expect(countLiveWindows([win(), win(true), win()])).toBe(2);
    expect(countLiveWindows([win(true)])).toBe(0);
    expect(countLiveWindows([])).toBe(0);
  });
});

describe("shouldVetoWindowClose", () => {
  it("asks before closing the last window, because that quits the app", () => {
    expect(shouldVetoWindowClose({ ...OPEN, windows: [win()] })).toBe(true);
  });

  it("does not ask when other windows remain", () => {
    expect(shouldVetoWindowClose({ ...OPEN, windows: [win(), win()] })).toBe(false);
  });

  // A window closed moments ago can still be in getAllWindows(); counting it
  // would make the real last window look like one of two and skip the prompt.
  it("treats a window whose only sibling is destroyed as the last one", () => {
    expect(shouldVetoWindowClose({ ...OPEN, windows: [win(), win(true)] })).toBe(true);
  });

  // quitAndInstall() closes every window before calling app.quit(). A veto here
  // strands the updater with a half-finished handoff.
  it("never vetoes once the quit is committed", () => {
    expect(
      shouldVetoWindowClose({ windows: [win()], quitCommitted: true, sessionEnding: false }),
    ).toBe(false);
  });

  it("never vetoes while the OS session is ending", () => {
    expect(
      shouldVetoWindowClose({ windows: [win()], quitCommitted: false, sessionEnding: true }),
    ).toBe(false);
  });

  // Whether the closing window is still listed during its own `close` event is
  // an Electron detail we do not depend on: both "it counts itself" (1) and "it
  // is already gone" (0) mean no window survives, so both prompt.
  it("prompts whether or not the closing window still counts itself", () => {
    expect(shouldVetoWindowClose({ ...OPEN, windows: [] })).toBe(true);
    expect(shouldVetoWindowClose({ ...OPEN, windows: [win(true)] })).toBe(true);
  });
});
