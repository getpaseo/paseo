import { describe, expect, it } from "vitest";
import {
  BackgroundTaskDescriptorPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

const PARENT_AGENT_ID = "00000000-0000-4000-8000-000000000001";

describe("background task wire schemas", () => {
  it("accepts a shell task descriptor", () => {
    const parsed = BackgroundTaskDescriptorPayloadSchema.parse({
      taskId: "bg-1",
      parentAgentId: PARENT_AGENT_ID,
      type: "shell",
      description: "Dev server",
      command: "npm run dev",
      status: "running",
      outputFile: null,
      lastSummary: null,
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(parsed.taskId).toBe("bg-1");
    expect(parsed.status).toBe("running");
  });

  it("parses list request/response and update push", () => {
    const request = SessionInboundMessageSchema.parse({
      type: "agent.background_tasks.list.request",
      requestId: "r1",
      parentAgentId: PARENT_AGENT_ID,
    });
    expect(request.type).toBe("agent.background_tasks.list.request");

    const response = SessionOutboundMessageSchema.parse({
      type: "agent.background_tasks.list.response",
      payload: {
        requestId: "r1",
        parentAgentId: PARENT_AGENT_ID,
        tasks: [],
        error: null,
      },
    });
    expect(response.type).toBe("agent.background_tasks.list.response");

    const update = SessionOutboundMessageSchema.parse({
      type: "agent.background_tasks.update",
      payload: {
        parentAgentId: PARENT_AGENT_ID,
        tasks: [],
      },
    });
    expect(update.type).toBe("agent.background_tasks.update");
  });

  it("parses stop and output request/response pairs", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.background_tasks.stop.request",
        requestId: "r2",
        parentAgentId: PARENT_AGENT_ID,
        taskId: "bg-1",
      }).type,
    ).toBe("agent.background_tasks.stop.request");

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.background_tasks.stop.response",
        payload: {
          requestId: "r2",
          parentAgentId: PARENT_AGENT_ID,
          taskId: "bg-1",
          error: null,
        },
      }).type,
    ).toBe("agent.background_tasks.stop.response");

    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.background_tasks.output.get.request",
        requestId: "r3",
        parentAgentId: PARENT_AGENT_ID,
        taskId: "bg-1",
        cursor: 0,
        maxBytes: 1024,
      }).type,
    ).toBe("agent.background_tasks.output.get.request");

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.background_tasks.output.get.response",
        payload: {
          requestId: "r3",
          parentAgentId: PARENT_AGENT_ID,
          taskId: "bg-1",
          text: "hello",
          nextCursor: 5,
          eof: false,
          error: null,
        },
      }).type,
    ).toBe("agent.background_tasks.output.get.response");

    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.background_tasks.output.subscribe.request",
        requestId: "r4",
        parentAgentId: PARENT_AGENT_ID,
        taskId: "bg-1",
      }).type,
    ).toBe("agent.background_tasks.output.subscribe.request");

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.background_tasks.output.subscribe.response",
        payload: {
          requestId: "r4",
          parentAgentId: PARENT_AGENT_ID,
          taskId: "bg-1",
          error: null,
        },
      }).type,
    ).toBe("agent.background_tasks.output.subscribe.response");

    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.background_tasks.output.unsubscribe.request",
        requestId: "r5",
        parentAgentId: PARENT_AGENT_ID,
        taskId: "bg-1",
      }).type,
    ).toBe("agent.background_tasks.output.unsubscribe.request");

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.background_tasks.output.unsubscribe.response",
        payload: {
          requestId: "r5",
          parentAgentId: PARENT_AGENT_ID,
          taskId: "bg-1",
          error: null,
        },
      }).type,
    ).toBe("agent.background_tasks.output.unsubscribe.response");

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.background_tasks.output.update",
        payload: {
          parentAgentId: PARENT_AGENT_ID,
          taskId: "bg-1",
          text: "line\n",
          nextCursor: 12,
          eof: false,
        },
      }).type,
    ).toBe("agent.background_tasks.output.update");
  });
});
