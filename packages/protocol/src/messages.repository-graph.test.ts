import { describe, expect, test } from "vitest";
import {
  CheckoutRepositoryGraphGetHistoryRequestSchema,
  CheckoutRepositoryGraphGetHistoryResponseSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

describe("checkout.repository_graph.get_history schemas", () => {
  const request = {
    type: "checkout.repository_graph.get_history.request" as const,
    cwd: "/tmp/repo",
    limit: 200,
    requestId: "graph-request",
  };
  const response = {
    type: "checkout.repository_graph.get_history.response" as const,
    payload: {
      cwd: "/tmp/repo",
      commits: [
        {
          sha: "abc",
          shortSha: "abc",
          parents: ["def"],
          subject: "subject",
          authorName: "Test User",
          authorDate: "2026-01-01T00:00:00Z",
          refs: [{ name: "main", kind: "head" as const, current: true }],
        },
      ],
      hasMore: false,
      error: null,
      requestId: "graph-request",
    },
  };

  test("parses requests through the inbound union", () => {
    expect(CheckoutRepositoryGraphGetHistoryRequestSchema.parse(request)).toEqual(request);
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
  });

  test("parses responses through the outbound union", () => {
    expect(CheckoutRepositoryGraphGetHistoryResponseSchema.parse(response)).toEqual(response);
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
  });

  test("keeps the capability optional", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "srv_test",
        features: { repositoryGraph: true },
      }).features,
    ).toEqual({ repositoryGraph: true });
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "srv_test",
        features: {},
      }).features,
    ).toEqual({});
  });
});
