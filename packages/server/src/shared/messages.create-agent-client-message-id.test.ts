import { describe, expect, it } from "vitest";
import { SessionInboundMessageSchema } from "./messages";

describe("create_agent_request clientMessageId", () => {
  it("accepts clientMessageId for stable initial prompt transfer", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "create_agent_request",
      requestId: "req-1",
      clientMessageId: "client-msg-1",
      config: {
        provider: "claude",
        cwd: "/tmp/project",
      },
      initialPrompt: "hello",
    });

    expect(parsed.type).toBe("create_agent_request");
    if (parsed.type !== "create_agent_request") {
      throw new Error("Expected create_agent_request");
    }
    expect(parsed.clientMessageId).toBe("client-msg-1");
  });
});
