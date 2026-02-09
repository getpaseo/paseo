import { describe, expect, it } from "vitest";

import { AgentTimelineItemPayloadSchema } from "./messages.js";

function canonicalBase() {
  return {
    type: "tool_call" as const,
    callId: "call_123",
    name: "shell",
    detail: {
      type: "shell" as const,
      command: "pwd",
    },
  };
}

describe("shared messages tool_call schema", () => {
  it("parses each status-discriminated tool_call variant at runtime", () => {
    const running = AgentTimelineItemPayloadSchema.parse({
      ...canonicalBase(),
      status: "running",
      error: null,
    });

    const completed = AgentTimelineItemPayloadSchema.parse({
      ...canonicalBase(),
      status: "completed",
      error: null,
    });

    const failed = AgentTimelineItemPayloadSchema.parse({
      ...canonicalBase(),
      status: "failed",
      error: { message: "command failed" },
    });

    const canceled = AgentTimelineItemPayloadSchema.parse({
      ...canonicalBase(),
      status: "canceled",
      error: null,
    });

    expect(running.type).toBe("tool_call");
    expect(completed.type).toBe("tool_call");
    expect(failed.type).toBe("tool_call");
    expect(canceled.type).toBe("tool_call");
  });

  it("rejects non-recoverable invalid tool_call payloads", () => {
    const missingCallId = AgentTimelineItemPayloadSchema.safeParse({
      type: "tool_call",
      name: "shell",
      status: "running",
      detail: {
        type: "shell",
        command: "pwd",
      },
      error: null,
    });

    const unknownStatus = AgentTimelineItemPayloadSchema.safeParse({
      ...canonicalBase(),
      status: "mystery_status",
      error: null,
    });

    expect(missingCallId.success).toBe(false);
    expect(unknownStatus.success).toBe(false);
  });

  it("rejects legacy status/error combinations without normalization", () => {
    const completedWithError = AgentTimelineItemPayloadSchema.safeParse({
      ...canonicalBase(),
      status: "completed",
      error: { message: "unexpected" },
    });

    const failedWithoutError = AgentTimelineItemPayloadSchema.safeParse({
      ...canonicalBase(),
      status: "failed",
      error: null,
    });

    const missingDetail = AgentTimelineItemPayloadSchema.safeParse({
      type: "tool_call",
      callId: "call_missing_detail",
      name: "shell",
      status: "running",
      error: null,
    });

    const legacyStatus = AgentTimelineItemPayloadSchema.safeParse({
      ...canonicalBase(),
      status: "inProgress",
      error: null,
    });

    expect(completedWithError.success).toBe(false);
    expect(failedWithoutError.success).toBe(false);
    expect(missingDetail.success).toBe(false);
    expect(legacyStatus.success).toBe(false);
  });
});
