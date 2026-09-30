import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimNativeTerminalKeyboard,
  isNativeTerminalKeyboardClaimed,
  resetNativeTerminalKeyboardClaims,
  subscribeNativeTerminalKeyboard,
} from "./native-terminal-keyboard";

afterEach(() => {
  resetNativeTerminalKeyboardClaims();
});

describe("claimNativeTerminalKeyboard", () => {
  it("reports a claim until it is released", () => {
    expect(isNativeTerminalKeyboardClaimed()).toBe(false);
    const release = claimNativeTerminalKeyboard("pane:1");
    expect(isNativeTerminalKeyboardClaimed()).toBe(true);
    release();
    expect(isNativeTerminalKeyboardClaimed()).toBe(false);
  });

  it("holds the claim through a tab switch, where the outgoing pane releases last", () => {
    const releaseOutgoing = claimNativeTerminalKeyboard("pane:1");
    const releaseIncoming = claimNativeTerminalKeyboard("pane:2");
    releaseOutgoing();
    expect(isNativeTerminalKeyboardClaimed()).toBe(true);
    releaseIncoming();
    expect(isNativeTerminalKeyboardClaimed()).toBe(false);
  });

  it("ignores a release that already ran", () => {
    const release = claimNativeTerminalKeyboard("pane:1");
    claimNativeTerminalKeyboard("pane:2");
    release();
    release();
    expect(isNativeTerminalKeyboardClaimed()).toBe(true);
  });

  it("notifies only when the answer changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNativeTerminalKeyboard(listener);

    const releaseFirst = claimNativeTerminalKeyboard("pane:1");
    const releaseSecond = claimNativeTerminalKeyboard("pane:2");
    expect(listener).toHaveBeenCalledTimes(1);

    releaseFirst();
    expect(listener).toHaveBeenCalledTimes(1);

    releaseSecond();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    claimNativeTerminalKeyboard("pane:3");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
