import { describe, expect, test, vi } from "vitest";

import { withAgentWorkspaceLifecycleAdmission } from "./agent-manager.js";
import type { WorkspaceLifecycleAdmission } from "../workspace-lifecycle-operation-service.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { PaseoWorkspaceLifecycleOperationService } from "../workspace-lifecycle-operation-service.js";
import { FileBackedWorkspaceLifecycleOperationStore } from "../workspace-lifecycle-operation-store.js";

describe("agent workspace lifecycle admission", () => {
  test("uses the workspace resource lease before registering an agent", async () => {
    const action = vi.fn(async () => "registered");
    const withSharedAdmission = vi.fn(async (_input, callback) => callback());
    const admission = { withSharedAdmission } as WorkspaceLifecycleAdmission;

    await expect(
      withAgentWorkspaceLifecycleAdmission(
        admission,
        { workspaceId: "wks_agent", cwd: "C:/repo", actor: "agent:create" },
        action,
      ),
    ).resolves.toBe("registered");
    expect(withSharedAdmission).toHaveBeenCalledWith(
      { resourceKey: "workspace:wks_agent", actor: "agent:create" },
      action,
    );
  });

  test("does not start the agent mutation when admission rejects", async () => {
    const action = vi.fn(async () => "registered");
    const admission = {
      withSharedAdmission: vi.fn(async () => {
        throw new Error("workspace lifecycle admission closed");
      }),
    } as unknown as WorkspaceLifecycleAdmission;

    await expect(
      withAgentWorkspaceLifecycleAdmission(
        admission,
        { workspaceId: "wks_closed", cwd: "C:/repo", actor: "agent:run" },
        action,
      ),
    ).rejects.toThrow(/admission closed/i);
    expect(action).not.toHaveBeenCalled();
  });

  test("agent creation is refused while workspace lifecycle admission is closed", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-lifecycle-admission-"));
    try {
      const store = new FileBackedWorkspaceLifecycleOperationStore({
        filePath: path.join(root, "workspace-lifecycle-operations.json"),
        logger: createTestLogger(),
      });
      const lifecycle = new PaseoWorkspaceLifecycleOperationService({
        store,
        logger: createTestLogger(),
      });
      const manager = new AgentManager({
        clients: {},
        logger: createTestLogger(),
      });
      manager.setWorkspaceLifecycleOperations(lifecycle);

      let releaseQuiesce!: () => void;
      const removal = lifecycle.runRemoval({
        operationId: "close-workspace-admission",
        fingerprint: "close-workspace-admission",
        resourceKey: "workspace:wks_admission",
        allowDestructiveMutation: true,
        quiesce: () => new Promise<void>((resolveQuiesce) => (releaseQuiesce = resolveQuiesce)),
        verify: async () => true,
        mutate: async () => ({ removed: true }),
      });
      await vi.waitFor(async () => {
        expect((await store.get("close-workspace-admission"))?.state).toBe("ADMISSION_CLOSED");
      });

      await expect(
        manager.createAgent({ provider: "codex", cwd: root }, undefined, {
          workspaceId: "wks_admission",
        }),
      ).rejects.toThrow(/admission closed/i);

      releaseQuiesce();
      await expect(removal).resolves.toEqual({ removed: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
