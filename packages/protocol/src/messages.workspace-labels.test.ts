import { describe, expect, test } from "vitest";
import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

describe("workspace label wire schemas", () => {
  test("keeps the capability optional for old daemons", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "old-host",
        features: {},
      }).features.workspaceLabels,
    ).toBeUndefined();
  });

  test("parses the explicit list subscription and sequenced response", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "workspace.label.list.request",
        requestId: "req-1",
        subscribe: { subscriptionId: "labels-1" },
        sync: { generation: "generation-1", afterSeq: 4 },
      }),
    ).toMatchObject({ type: "workspace.label.list.request" });
    expect(
      SessionOutboundMessageSchema.parse({
        type: "workspace.label.list.response",
        payload: {
          requestId: "req-1",
          labels: [],
          sync: {
            mode: "changes",
            generation: "generation-1",
            headSeq: 4,
            removals: [],
          },
        },
      }),
    ).toMatchObject({ type: "workspace.label.list.response", payload: { labels: [] } });
  });

  test("accepts optional label data without requiring it on legacy workspace messages", () => {
    expect(
      SessionOutboundMessageSchema.parse({
        type: "workspace.label.update",
        payload: {
          kind: "upsert",
          label: { name: "Needs review", color: "sky" },
          generation: "generation-1",
          seq: 5,
        },
      }),
    ).toMatchObject({ payload: { label: { name: "Needs review", color: "sky" } } });
  });

  test("uses a distinct operation for authoritative non-mutating delete inspection", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "workspace.label.delete.inspect.request",
        requestId: "req-delete",
        name: "Urgent",
      }),
    ).toMatchObject({ type: "workspace.label.delete.inspect.request" });
  });

  test("requires the fields promised by each operation", () => {
    expect(() =>
      SessionOutboundMessageSchema.parse({
        type: "workspace.label.assignment.set.response",
        payload: { requestId: "req-assignment", label: { name: "Urgent", color: "red" } },
      }),
    ).toThrow();
    expect(() =>
      SessionOutboundMessageSchema.parse({
        type: "workspace.label.delete.inspect.response",
        payload: { requestId: "req-inspect" },
      }),
    ).toThrow();
  });
});
