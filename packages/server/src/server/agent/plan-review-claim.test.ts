import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

test("plan review claims survive storage/reload and release only for the exact permission", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "plan-review-claim-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(directory, logger);
  const client = createTestAgentClient("codex");
  const manager = new AgentManager({ registry: storage, clients: { codex: client }, logger });
  const reloaded = new AgentManager({ registry: storage, clients: { codex: client }, logger });
  const agent = await manager.createAgent({ provider: "codex", cwd: directory }, undefined, {
    workspaceId: "workspace",
  });
  const claim = {
    agentId: agent.id,
    workspaceId: "workspace",
    callId: "plan",
    permissionRequestId: "permission",
    active: true,
  };
  try {
    agent.pendingPermissions.set("permission", {
      id: "permission",
      provider: "codex",
      name: "Plan",
      kind: "plan",
      sourcePlanCallId: "plan",
    });
    await expect(manager.setPlanReviewClaim({ ...claim, workspaceId: "other" })).rejects.toThrow(
      "another workspace",
    );
    await expect(manager.setPlanReviewClaim({ ...claim, callId: "forged" })).rejects.toThrow(
      "no longer pending",
    );
    await manager.setPlanReviewClaim(claim);
    await manager.setPlanReviewClaim(claim);
    expect((await storage.get(agent.id))?.planReviewClaims).toEqual({ plan: "permission" });
    await manager.closeAgent(agent.id);
    const resumed = await ensureAgentLoaded(agent.id, {
      agentManager: reloaded,
      agentStorage: storage,
      logger,
    });
    expect(resumed.planReviewClaims).toEqual({ plan: "permission" });
    await expect(
      reloaded.respondToPermission(agent.id, "permission", { behavior: "allow" }),
    ).rejects.toThrow("review");
    await expect(
      reloaded.setPlanReviewClaim({ ...claim, active: false, permissionRequestId: "other" }),
    ).rejects.toThrow("another permission");
    await reloaded.setPlanReviewClaim({ ...claim, active: false });
    await reloaded.setPlanReviewClaim({ ...claim, active: false });
    expect((await storage.get(agent.id))?.planReviewClaims).toEqual({});
  } finally {
    await manager.closeAgent(agent.id);
    await reloaded.closeAgent(agent.id);
    await rm(directory, { recursive: true, force: true });
  }
});
