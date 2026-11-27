import { describe, expect, it } from "vitest";
import { timelineItemIdentity } from "./timeline-identity.js";

describe("timelineItemIdentity", () => {
  it("uses tool call ids and plugin-scoped ids", () => {
    expect(
      timelineItemIdentity({
        type: "tool_call",
        callId: "call-1",
        name: "read",
        detail: { type: "unknown", input: null, output: null },
        status: "running",
        error: null,
      }),
    ).toBe("call-1");
    expect(
      timelineItemIdentity({
        type: "plugin",
        id: "row-1",
        pluginId: "review",
        kind: "review",
        version: 1,
        data: {},
      }),
    ).toBe("review/row-1");
    expect(timelineItemIdentity({ type: "reasoning", text: "hi" })).toBeNull();
  });
});
