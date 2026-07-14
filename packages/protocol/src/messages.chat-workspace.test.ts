import { describe, expect, test } from "vitest";

import { SessionInboundMessageSchema } from "./messages.js";

describe("create_agent_request chatWorkspace field", () => {
  test("accepts optional chatWorkspace: true", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "create_agent_request",
      requestId: "create-chat",
      config: {
        provider: "claude",
        cwd: "",
      },
      chatWorkspace: true,
    });

    expect(parsed).toEqual({
      type: "create_agent_request",
      requestId: "create-chat",
      config: {
        provider: "claude",
        cwd: "",
      },
      chatWorkspace: true,
      labels: {},
    });
  });

  test("keeps legacy create_agent_request defaults unchanged", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "create_agent_request",
      requestId: "legacy-create-agent",
      config: {
        provider: "codex",
        cwd: "/repo/app",
      },
    });

    expect(parsed).toEqual({
      type: "create_agent_request",
      requestId: "legacy-create-agent",
      config: {
        provider: "codex",
        cwd: "/repo/app",
      },
      labels: {},
    });
  });

  test("rejects non-boolean chatWorkspace values", () => {
    expect(() => {
      SessionInboundMessageSchema.parse({
        type: "create_agent_request",
        requestId: "bad-chat",
        config: {
          provider: "claude",
          cwd: "",
        },
        chatWorkspace: "true",
      });
    }).toThrow();

    expect(() => {
      SessionInboundMessageSchema.parse({
        type: "create_agent_request",
        requestId: "bad-chat",
        config: {
          provider: "claude",
          cwd: "",
        },
        chatWorkspace: 1,
      });
    }).toThrow();
  });
});
