import { describe, expect, it } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "../messages.js";

describe("workflow RPC schemas", () => {
  it("accepts dotted spec and run requests", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "workflow.spec.save.request",
        requestId: "request-1",
        spec: { version: "0.2", name: "custom" },
      }),
    ).toMatchObject({ type: "workflow.spec.save.request" });
    expect(
      SessionInboundMessageSchema.parse({
        type: "workflow.run.start.request",
        requestId: "request-2",
        workflowId: "custom",
        parameters: { objective: "Ship it" },
        context: { workspaceId: "workspace-1", agentId: "agent-1" },
      }),
    ).toMatchObject({ type: "workflow.run.start.request" });
  });

  it("keeps workflow launch context free of client filesystem authority", () => {
    const result = SessionInboundMessageSchema.safeParse({
      type: "workflow.run.start.request",
      requestId: "request-1",
      workflowId: "custom",
      context: { cwd: "/private/repo" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts structured inspection responses", () => {
    const now = "2026-07-30T00:00:00.000Z";
    const run = {
      id: "run-1",
      workflowId: "custom",
      workflowName: "Custom",
      status: "running",
      reason: null,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: null,
      iteration: 1,
      activeTurns: 1,
      legacy: false,
      resumable: false,
      workspaceIds: ["workspace-1"],
      agentIds: ["agent-1"],
    };
    expect(
      SessionOutboundMessageSchema.parse({
        type: "workflow.run.inspect.response",
        payload: {
          requestId: "request-1",
          details: {
            run,
            spec: { version: "0.2", name: "custom" },
            state: { schemaVersion: "paseo.workflows.run.v0.2" },
            events: [
              {
                seq: 1,
                timestamp: now,
                type: "turn_started",
                agentId: "agent-1",
              },
            ],
            prompts: [],
          },
          error: null,
        },
      }),
    ).toMatchObject({ type: "workflow.run.inspect.response" });
  });
});
