import { describe, expect, it } from "vitest";

import { AgentTimelineItemPayloadSchema } from "./messages.js";

function canonicalBase() {
  return {
    type: "tool_call" as const,
    callId: "call_123",
    name: "shell",
    input: { command: "pwd" },
    output: null,
  };
}

describe("shared messages tool_call schema", () => {
  it("parses each status-discriminated tool_call variant at runtime", () => {
    const running = AgentTimelineItemPayloadSchema.parse({
      ...canonicalBase(),
      status: "running",
      error: null,
      detail: {
        type: "shell",
        command: "pwd",
      },
    });

    const completed = AgentTimelineItemPayloadSchema.parse({
      ...canonicalBase(),
      status: "completed",
      error: null,
      output: { output: "/tmp/repo" },
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
      input: { command: "pwd" },
      output: null,
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

  it("normalizes recoverable legacy status/error combinations", () => {
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

    const missingOutput = AgentTimelineItemPayloadSchema.safeParse({
      type: "tool_call",
      callId: "call_missing_output",
      name: "shell",
      status: "running",
      input: { command: "pwd" },
      error: null,
    });

    expect(completedWithError.success).toBe(true);
    expect(failedWithoutError.success).toBe(true);
    expect(missingOutput.success).toBe(true);

    if (completedWithError.success && completedWithError.data.type === "tool_call") {
      expect(completedWithError.data.error).toBeNull();
    }
    if (failedWithoutError.success && failedWithoutError.data.type === "tool_call") {
      expect(failedWithoutError.data.error).toEqual({ message: "Tool call failed" });
    }
    if (missingOutput.success && missingOutput.data.type === "tool_call") {
      expect(missingOutput.data.output).toBeNull();
    }
  });
});
