import { describe, expect, it } from "vitest";

import { toSetModeResult } from "./mode.js";

describe("toSetModeResult", () => {
  it("reports the mode the session still runs when the provider refuses the switch", () => {
    const result = toSetModeResult(
      {
        id: "abcdef1234567890",
        runtimeInfo: { provider: "dsh", sessionId: "session-1", modeId: "workspace-write" },
      },
      "danger-full-access",
      {
        type: "warning",
        message: "Start a new DeepSeek Harness session to change the permission mode.",
      },
    );

    expect(result).toEqual({
      agentId: "abcdef1",
      mode: "workspace-write",
      noticeType: "warning",
      notice: "Start a new DeepSeek Harness session to change the permission mode.",
    });
  });

  it("reports the requested mode when the session does not publish one", () => {
    const result = toSetModeResult(
      { id: "abcdef1234567890", runtimeInfo: { provider: "claude", sessionId: "session-2" } },
      "plan",
      null,
    );

    expect(result).toEqual({
      agentId: "abcdef1",
      mode: "plan",
      noticeType: null,
      notice: null,
    });
  });
});
