import { describe, expect, test } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";

describe("list_commands_request schema", () => {
  test("accepts legacy agent-only payload", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "list_commands_request",
      agentId: "agent-123",
      requestId: "req-123",
    });

    expect(parsed.type).toBe("list_commands_request");
    if (parsed.type !== "list_commands_request") {
      throw new Error("Expected list_commands_request message");
    }
    expect(parsed.agentId).toBe("agent-123");
    expect(parsed.draftConfig).toBeUndefined();
  });

  test("accepts draft command context payload", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "list_commands_request",
      agentId: "__new_agent__",
      draftConfig: {
        provider: "codex",
        cwd: "/tmp/project",
        modeId: "bypassPermissions",
        model: "gpt-5",
        thinkingOptionId: "off",
        featureValues: {
          plan_mode: true,
        },
      },
      requestId: "req-456",
    });

    expect(parsed.type).toBe("list_commands_request");
    if (parsed.type !== "list_commands_request") {
      throw new Error("Expected list_commands_request message");
    }
    expect(parsed.draftConfig).toEqual({
      provider: "codex",
      cwd: "/tmp/project",
      modeId: "bypassPermissions",
      model: "gpt-5",
      thinkingOptionId: "off",
      featureValues: {
        plan_mode: true,
      },
    });
  });

  test("preserves command kind metadata in responses", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "list_commands_response",
      payload: {
        agentId: "agent-123",
        requestId: "req-123",
        error: null,
        commands: [
          {
            name: "taste",
            description: "Apply code taste",
            argumentHint: "",
            kind: "skill",
          },
        ],
      },
    });

    expect(parsed.type).toBe("list_commands_response");
    if (parsed.type !== "list_commands_response") {
      throw new Error("Expected list_commands_response message");
    }
    expect(parsed.payload.commands).toEqual([
      {
        name: "taste",
        description: "Apply code taste",
        argumentHint: "",
        kind: "skill",
      },
    ]);
  });

  test("falls back to command for unknown future command kinds", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "list_commands_response",
      payload: {
        agentId: "agent-123",
        requestId: "req-123",
        error: null,
        commands: [
          {
            name: "future-command",
            description: "Future command kind",
            argumentHint: "",
            kind: "future-kind",
          },
        ],
      },
    });

    expect(parsed.type).toBe("list_commands_response");
    if (parsed.type !== "list_commands_response") {
      throw new Error("Expected list_commands_response message");
    }
    expect(parsed.payload.commands[0]?.kind).toBe("command");
  });
});
