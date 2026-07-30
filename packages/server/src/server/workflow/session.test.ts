import { describe, expect, it, vi } from "vitest";
import type { WorkflowService } from "./service.js";
import { WorkflowSession } from "./session.js";

describe("WorkflowSession", () => {
  it("routes dotted start RPCs through the shared service and preserves context", async () => {
    const emit = vi.fn();
    const startRun = vi.fn().mockResolvedValue({
      id: "wfr_test",
      workflowId: "echo-demo",
      workflowName: "Echo demo",
      status: "queued",
      reason: null,
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      iteration: 0,
      activeTurns: 0,
      legacy: false,
      resumable: false,
      workspaceIds: [],
      agentIds: [],
    });
    const session = new WorkflowSession({ emit }, { startRun } as unknown as WorkflowService);

    await session.dispatch({
      type: "workflow.run.start.request",
      requestId: "request-1",
      workflowId: "echo-demo",
      parameters: { message: "hello" },
      context: { workspaceId: "workspace-1" },
    });

    expect(startRun).toHaveBeenCalledWith({
      workflowId: "echo-demo",
      parameters: { message: "hello" },
      context: { workspaceId: "workspace-1" },
    });
    expect(emit).toHaveBeenCalledWith({
      type: "workflow.run.start.response",
      payload: {
        requestId: "request-1",
        run: expect.objectContaining({ id: "wfr_test", status: "queued" }),
        error: null,
      },
    });
  });

  it("returns persistent RPC errors instead of throwing through the session", async () => {
    const emit = vi.fn();
    const session = new WorkflowSession({ emit }, {
      inspectRun: vi.fn().mockRejectedValue(new Error("corrupt workflow state")),
    } as unknown as WorkflowService);
    await session.dispatch({
      type: "workflow.run.inspect.request",
      requestId: "request-2",
      runId: "bad-run",
    });
    expect(emit).toHaveBeenCalledWith({
      type: "workflow.run.inspect.response",
      payload: {
        requestId: "request-2",
        details: null,
        error: "corrupt workflow state",
      },
    });
  });
});
