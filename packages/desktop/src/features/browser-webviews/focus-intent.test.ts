import { afterEach, describe, expect, it } from "vitest";
import {
  forgetBrowserFocusIntent,
  isUserFocusOfBrowser,
  recordBrowserAutomationInput,
  recordBrowserMousePress,
} from "./focus-intent.js";

const GUEST = 7;

describe("browser focus intent", () => {
  afterEach(() => forgetBrowserFocusIntent(GUEST));

  it("refuses focus that no mouse press preceded, such as page autofocus", () => {
    expect(isUserFocusOfBrowser(GUEST, 1_000)).toBe(false);
  });

  it("allows focus right after a user press", () => {
    recordBrowserMousePress(GUEST, 1_000);
    expect(isUserFocusOfBrowser(GUEST, 1_200)).toBe(true);
  });

  it("expires a user press after the window", () => {
    recordBrowserMousePress(GUEST, 1_000);
    expect(isUserFocusOfBrowser(GUEST, 2_500)).toBe(false);
  });

  it("ignores presses dispatched by browser automation", () => {
    recordBrowserAutomationInput(GUEST, 1_000);
    recordBrowserMousePress(GUEST, 1_010);
    expect(isUserFocusOfBrowser(GUEST, 1_020)).toBe(false);
  });

  it("keeps presses of other guests separate", () => {
    recordBrowserMousePress(GUEST, 1_000);
    expect(isUserFocusOfBrowser(8, 1_100)).toBe(false);
    forgetBrowserFocusIntent(8);
  });
});
