import { describe, expect, test } from "vitest";

import { SessionInboundMessageSchema } from "./messages.js";

describe("create request internal field", () => {
  test("accepts internal on create_agent_request", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "create_agent_request",
      requestId: "create-agent-internal",
      config: {
        provider: "codex",
        cwd: "/repo/app",
      },
      internal: true,
    });

    expect(parsed).toEqual({
      type: "create_agent_request",
      requestId: "create-agent-internal",
      config: {
        provider: "codex",
        cwd: "/repo/app",
      },
      internal: true,
      labels: {},
    });
  });

  test("accepts internal on agent.create.request", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "agent.create.request",
      requestId: "agent-create-internal",
      config: {
        provider: "codex",
        cwd: "/repo/app",
      },
      internal: true,
    });

    expect(parsed).toEqual({
      type: "agent.create.request",
      requestId: "agent-create-internal",
      config: {
        provider: "codex",
        cwd: "/repo/app",
      },
      internal: true,
      labels: {},
    });
  });
});
