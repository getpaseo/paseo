import { expect, test } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";

test("parses daemon-owned agent queue messages", () => {
  const request = SessionInboundMessageSchema.parse({
    type: "agent.queue.create.request",
    agentId: "agent-1",
    text: "continue with tests",
    requestId: "request-1",
  });
  expect(request.type).toBe("agent.queue.create.request");

  const update = SessionOutboundMessageSchema.parse({
    type: "agent.queue.update",
    payload: {
      agentId: "agent-1",
      prompts: [
        {
          id: "prompt-1",
          agentId: "agent-1",
          text: "continue with tests",
          attachments: [],
          createdAt: "2026-08-24T12:00:00.000Z",
          createdByClientId: "client-1",
        },
      ],
    },
  });
  expect(update.type).toBe("agent.queue.update");
});
