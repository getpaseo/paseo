import { describe, expect, test } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";

describe("provider subagent protocol", () => {
  test("accepts a scoped timeline request and structured live update", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.provider_subagents.timeline.get.request",
        parentAgentId: "parent-1",
        subagentId: "child-1",
        requestId: "request-1",
      }),
    ).toMatchObject({ parentAgentId: "parent-1", subagentId: "child-1" });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.provider_subagents.update",
        payload: {
          kind: "timeline",
          parentAgentId: "parent-1",
          subagentId: "child-1",
          provider: "claude",
          epoch: "epoch-1",
          seq: 4,
          timestamp: "2026-07-12T10:00:00.000Z",
          item: { type: "assistant_message", text: "Found it." },
        },
      }),
    ).toMatchObject({
      payload: {
        kind: "timeline",
        parentAgentId: "parent-1",
        subagentId: "child-1",
        seq: 4,
      },
    });
  });

  test("accepts a provider child working directory while remaining compatible when absent", () => {
    const descriptor = {
      id: "child-1",
      parentAgentId: "parent-1",
      provider: "opencode",
      title: "Explore",
      description: null,
      status: "running",
      createdAt: "2026-07-12T10:00:00.000Z",
      updatedAt: "2026-07-12T10:00:00.000Z",
      toolCallId: null,
    };

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.provider_subagents.list.response",
        payload: {
          requestId: "request-1",
          parentAgentId: "parent-1",
          subagents: [{ ...descriptor, cwd: "/workspace/child" }],
          error: null,
        },
      }),
    ).toMatchObject({ payload: { subagents: [{ cwd: "/workspace/child" }] } });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.provider_subagents.list.response",
        payload: {
          requestId: "request-2",
          parentAgentId: "parent-1",
          subagents: [descriptor],
          error: null,
        },
      }),
    ).toMatchObject({ payload: { subagents: [{ id: "child-1" }] } });
  });

  test("accepts one archive-finished operation across managed and provider children", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.subagents.archive_finished.request",
        parentAgentId: "parent-1",
        requestId: "request-1",
      }),
    ).toMatchObject({ parentAgentId: "parent-1" });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.subagents.archive_finished.response",
        payload: {
          requestId: "request-1",
          parentAgentId: "parent-1",
          archivedAgentIds: ["managed-1"],
          dismissedProviderSubagentIds: ["native-1"],
          error: null,
        },
      }),
    ).toMatchObject({
      payload: {
        archivedAgentIds: ["managed-1"],
        dismissedProviderSubagentIds: ["native-1"],
      },
    });
  });

  test("accepts a remove update that preserves an open provider timeline", () => {
    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.provider_subagents.update",
        payload: {
          kind: "remove",
          parentAgentId: "parent-1",
          subagentId: "child-1",
          retainTimeline: true,
        },
      }),
    ).toMatchObject({ payload: { kind: "remove", retainTimeline: true } });
  });

  test("accepts a retained descriptor with provider timeline history", () => {
    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.provider_subagents.timeline.get.response",
        payload: {
          requestId: "request-1",
          parentAgentId: "parent-1",
          subagentId: "child-1",
          provider: "codex",
          subagent: {
            id: "child-1",
            parentAgentId: "parent-1",
            provider: "codex",
            title: "Finished child",
            description: null,
            status: "completed",
            createdAt: "2026-07-12T10:00:00.000Z",
            updatedAt: "2026-07-12T10:01:00.000Z",
            toolCallId: null,
          },
          hiddenFromTrack: true,
          direction: "tail",
          epoch: "epoch-1",
          reset: false,
          staleCursor: false,
          gap: false,
          window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
          hasOlder: false,
          hasNewer: false,
          rows: [],
          error: null,
        },
      }),
    ).toMatchObject({ payload: { hiddenFromTrack: true, subagent: { id: "child-1" } } });
  });
});
