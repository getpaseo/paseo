import { describe, expect, it } from "vitest";
import { AgentRefreshedStatusPayloadSchema } from "./messages.js";

describe("AgentRefreshedStatusPayloadSchema", () => {
  it("accepts the account verification returned by a refreshed provider session", () => {
    expect(
      AgentRefreshedStatusPayloadSchema.parse({
        status: "agent_refreshed",
        agentId: "agent-1",
        requestId: "request-1",
        timelineSize: 12,
        providerAccountLabel: "new@example.com",
        providerAccountVerificationStatus: "verified",
      }),
    ).toEqual({
      status: "agent_refreshed",
      agentId: "agent-1",
      requestId: "request-1",
      timelineSize: 12,
      providerAccountLabel: "new@example.com",
      providerAccountVerificationStatus: "verified",
    });
  });

  it("continues to accept refresh responses without account metadata", () => {
    expect(
      AgentRefreshedStatusPayloadSchema.parse({
        status: "agent_refreshed",
        agentId: "agent-1",
        requestId: "request-1",
      }),
    ).toEqual({
      status: "agent_refreshed",
      agentId: "agent-1",
      requestId: "request-1",
    });
  });
});
