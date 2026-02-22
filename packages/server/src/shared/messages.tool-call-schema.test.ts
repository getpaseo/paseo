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

    const withTopLevelInputOutput = AgentTimelineItemPayloadSchema.safeParse({
      ...canonicalBase(),
      status: "running",
      error: null,
      input: { command: "pwd" },
      output: { exitCode: 0 },
    });

    expect(missingCallId.success).toBe(false);
    expect(unknownStatus.success).toBe(false);
    expect(withTopLevelInputOutput.success).toBe(false);
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

  it("parses canonical sub_agent detail payload", () => {
    const parsed = AgentTimelineItemPayloadSchema.parse({
      type: "tool_call",
      callId: "call_sub_agent_1",
      name: "Task",
      status: "running",
      error: null,
      detail: {
        type: "sub_agent",
        subAgentType: "Explore",
        description: "Inspect repository structure",
        log: "[Read] README.md\n[Bash] ls",
        actions: [
          {
            index: 1,
            toolName: "Read",
            summary: "README.md",
          },
          {
            index: 2,
            toolName: "Bash",
            summary: "ls",
          },
        ],
      },
    });

    expect(parsed.type).toBe("tool_call");
    if (parsed.type === "tool_call") {
      expect(parsed.detail.type).toBe("sub_agent");
      if (parsed.detail.type === "sub_agent") {
        expect(parsed.detail.subAgentType).toBe("Explore");
        expect(parsed.detail.actions).toHaveLength(2);
      }
    }
  });
});
