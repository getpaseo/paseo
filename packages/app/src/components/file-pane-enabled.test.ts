import { describe, expect, it } from "vitest";
import { isFileQueryEnabled } from "./file-pane-enabled";

describe("isFileQueryEnabled", () => {
  it("reads when there is a target, the tab is active, and the app is visible", () => {
    expect(isFileQueryEnabled({ hasReadTarget: true, isTabActive: true, isAppVisible: true })).toBe(
      true,
    );
  });

  it("does not read while the tab is hidden", () => {
    expect(
      isFileQueryEnabled({ hasReadTarget: true, isTabActive: false, isAppVisible: true }),
    ).toBe(false);
  });

  it("does not read while the app is backgrounded", () => {
    expect(
      isFileQueryEnabled({ hasReadTarget: true, isTabActive: true, isAppVisible: false }),
    ).toBe(false);
  });

  it("does not read without a resolved file target", () => {
    expect(
      isFileQueryEnabled({ hasReadTarget: false, isTabActive: true, isAppVisible: true }),
    ).toBe(false);
  });
});
