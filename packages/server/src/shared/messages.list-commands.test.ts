import { describe, expect, test } from "vitest";
import { SessionInboundMessageSchema } from "./messages.js";

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
    });
  });
});
