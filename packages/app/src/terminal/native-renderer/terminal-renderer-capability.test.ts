import { describe, expect, it } from "vitest";

import { resolveTerminalRendererSelection } from "./terminal-renderer-capability";

describe("terminal renderer capability", () => {
  it("requires input mode replay before attaching the native renderer", () => {
    expect(
      resolveTerminalRendererSelection({
        useLegacyTerminalRenderer: false,
        supportsTerminalInputModeReplay: false,
      }),
    ).toBe("update-host");
  });

  it("allows the native renderer when the daemon advertises input mode replay", () => {
    expect(
      resolveTerminalRendererSelection({
        useLegacyTerminalRenderer: false,
        supportsTerminalInputModeReplay: true,
      }),
    ).toBe("native-grid");
  });

  it("keeps the explicit legacy renderer available with older daemons", () => {
    expect(
      resolveTerminalRendererSelection({
        useLegacyTerminalRenderer: true,
        supportsTerminalInputModeReplay: false,
      }),
    ).toBe("webview");
  });
});
