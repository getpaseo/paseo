import { describe, expect, test } from "vitest";

import {
  ServerInfoStatusPayloadSchema,
  SessionEventSubscriptionSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

const ITEM = {
  id: "bash-1",
  kind: "shell",
  description: "sleep 20",
  startedAt: "2026-10-06T10:00:00.000Z",
};

describe("agent background work protocol", () => {
  test("accepts a list request and its response", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.background_work.list.request",
        agentId: "agent-1",
        requestId: "request-1",
      }),
    ).toMatchObject({ agentId: "agent-1", requestId: "request-1" });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.background_work.list.response",
        payload: { requestId: "request-1", agentId: "agent-1", items: [ITEM], error: null },
      }),
    ).toMatchObject({ payload: { items: [ITEM] } });
  });

  test("accepts an update with or without a subscription id", () => {
    for (const payload of [
      { agentId: "agent-1", items: [] },
      { subscriptionId: "events-1", agentId: "agent-1", items: [ITEM] },
    ]) {
      expect(
        SessionOutboundMessageSchema.parse({ type: "agent.background_work.update", payload }),
      ).toMatchObject({ payload });
    }
  });

  test("keeps kind an open string so new kinds parse on old clients", () => {
    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.background_work.update",
        payload: { agentId: "agent-1", items: [{ ...ITEM, kind: "future-kind" }] },
      }),
    ).toMatchObject({ payload: { items: [{ kind: "future-kind" }] } });
  });

  test("is a subscribable event", () => {
    expect(SessionEventSubscriptionSchema.parse("agent.background_work.update")).toBe(
      "agent.background_work.update",
    );
  });

  test("keeps the feature optional for older server info payloads", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-1",
        features: {},
      }).features?.agentBackgroundWork,
    ).toBeUndefined();
  });
});
