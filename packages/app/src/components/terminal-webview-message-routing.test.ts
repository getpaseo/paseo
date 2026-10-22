import { describe, expect, it } from "vitest";
import { shouldHandleTerminalBridgeMessage } from "./terminal-webview-message-routing";

describe("terminal WebView message routing", () => {
  it("rejects terminal messages from a stale stream", () => {
    expect(
      shouldHandleTerminalBridgeMessage(
        { type: "input", streamKey: "terminal-a" },
        { desiredStreamKey: "terminal-b", mountedStreamKey: "terminal-b" },
      ),
    ).toBe(false);
    expect(
      shouldHandleTerminalBridgeMessage(
        { type: "resize", streamKey: "terminal-a" },
        { desiredStreamKey: "terminal-b", mountedStreamKey: "terminal-b" },
      ),
    ).toBe(false);
  });

  it("rejects the old WebView stream while React is switching callbacks", () => {
    expect(
      shouldHandleTerminalBridgeMessage(
        { type: "input", streamKey: "terminal-a" },
        { desiredStreamKey: "terminal-b", mountedStreamKey: "terminal-a" },
      ),
    ).toBe(false);
  });

  it("accepts messages from the mounted stream and unscoped diagnostics", () => {
    expect(
      shouldHandleTerminalBridgeMessage(
        { type: "input", streamKey: "terminal-b" },
        { desiredStreamKey: "terminal-b", mountedStreamKey: "terminal-b" },
      ),
    ).toBe(true);
    expect(
      shouldHandleTerminalBridgeMessage(
        { type: "debug" },
        { desiredStreamKey: "terminal-b", mountedStreamKey: "terminal-b" },
      ),
    ).toBe(true);
  });
});
