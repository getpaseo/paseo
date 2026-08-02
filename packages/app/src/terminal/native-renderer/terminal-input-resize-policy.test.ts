import { describe, expect, it } from "vitest";

import { shouldClaimNativeTerminalSize } from "./terminal-input-resize-policy";

describe("native terminal input resize policy", () => {
  it("does not claim terminal size for text or virtual-key input", () => {
    expect(shouldClaimNativeTerminalSize("text")).toEqual(false);
    expect(shouldClaimNativeTerminalSize("key")).toEqual(false);
  });

  it("claims terminal size at focus and explicit keyboard/paste boundaries", () => {
    expect(shouldClaimNativeTerminalSize("focus")).toEqual(true);
    expect(shouldClaimNativeTerminalSize("showKeyboard")).toEqual(true);
    expect(shouldClaimNativeTerminalSize("paste")).toEqual(true);
    expect(shouldClaimNativeTerminalSize("resizeRequest")).toEqual(true);
  });
});
