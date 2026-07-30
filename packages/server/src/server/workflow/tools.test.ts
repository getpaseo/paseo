import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { createPaseoToolCatalog } from "../agent/tools/paseo-tools.js";
import type { WorkflowService } from "./service.js";

function createCatalog(service: Partial<WorkflowService>, callerAgentId?: string) {
  return createPaseoToolCatalog({
    agentManager: {} as AgentManager,
    agentStorage: {} as AgentStorage,
    providerSnapshotManager: {} as ProviderSnapshotManager,
    workflowService: service as WorkflowService,
    callerAgentId,
    logger: pino({ enabled: false }),
  });
}

describe("native workflow tools", () => {
  it("authorizes emit_event from the catalog caller instead of public arguments", async () => {
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    const catalog = createCatalog({ emitEvent }, "agent-owned");

    await expect(
      catalog.executeTool("emit_event", {
        event: "done",
        message: "handoff",
        data: { value: 1 },
        callerAgentId: "agent-spoofed",
        capability: "not-a-capability",
      }),
    ).resolves.toMatchObject({ structuredContent: { accepted: true } });
    expect(emitEvent).toHaveBeenCalledWith({
      callerAgentId: "agent-owned",
      event: "done",
      message: "handoff",
      data: { value: 1 },
    });
  });

  it("binds run_workflow to the caller and returns the queued run immediately", async () => {
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
    const catalog = createCatalog({ startRun }, "agent-caller");
    const result = await catalog.executeTool("run_workflow", {
      workflowId: "echo-demo",
      parameters: { message: "hello" },
      context: { agentId: "agent-spoofed" },
    });

    expect(startRun).toHaveBeenCalledWith({
      workflowId: "echo-demo",
      parameters: { message: "hello" },
      context: { agentId: "agent-caller" },
    });
    expect(result.structuredContent).toMatchObject({
      run: { id: "wfr_test", status: "queued" },
    });
  });
});
