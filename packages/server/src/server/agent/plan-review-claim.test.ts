import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "./agent-sdk-types.js";

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

test.each(["revision", "approval"] as const)(
  "conditional revision and approval share one admission lane: %s first",
  async (first) => {
    const directory = await mkdtemp(path.join(tmpdir(), "plan-revision-race-"));
    const logger = createTestLogger();
    const client = createTestAgentClient("codex");
    const manager = new AgentManager({ clients: { codex: client }, logger });
    const agent = await manager.createAgent({ provider: "codex", cwd: directory }, undefined, {
      workspaceId: "workspace",
    });
    const session = agent.session as typeof agent.session & {
      notifySubscribers(event: AgentStreamEvent): void;
    };
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const calls: string[] = [];
    const start = session.startTurn.bind(session);
    session.startTurn = async (...args) => {
      calls.push("revision");
      return start(...args);
    };
    const rows = manager.getTimelineRows.bind(manager);
    vi.spyOn(manager, "getTimelineRows").mockImplementation(async (...args) => {
      const snapshot = await rows(...args);
      if (first === "revision") {
        entered.resolve();
        await release.promise;
      }
      return snapshot;
    });
    session.respondToPermission = async () => {
      if (first === "approval") {
        entered.resolve();
        await release.promise;
      }
      calls.push("approval");
      session.notifySubscribers({
        type: "timeline",
        provider: "codex",
        item: {
          type: "tool_call",
          callId: "next-plan",
          name: "Plan",
          status: "completed",
          detail: { type: "plan", text: "Next plan" },
          metadata: { approved: true },
        },
      });
    };
    try {
      await manager.appendTimelineItem(agent.id, {
        type: "tool_call",
        callId: "source-plan",
        name: "Plan",
        status: "completed",
        detail: { type: "plan", text: "Source plan" },
      });
      agent.pendingPermissions.set("next-permission", {
        id: "next-permission",
        provider: "codex",
        name: "Plan",
        kind: "plan",
        sourcePlanCallId: "next-plan",
      });
      const revision = () =>
        manager.sendPlanRevision({
          agentId: agent.id,
          workspaceId: "workspace",
          callId: "source-plan",
          sourcePlanText: "Source plan",
          text: "Respond with exactly: Revised",
          messageId: "revision-once",
        });
      const approve = () =>
        manager.respondToPermission(agent.id, "next-permission", { behavior: "allow" });
      const firstRun = first === "revision" ? revision() : approve();
      await entered.promise;
      const secondRun = first === "revision" ? approve() : revision();
      expect(calls).toEqual([]);
      release.resolve();
      const results = await Promise.all([firstRun, secondRun]);
      expect(calls).toEqual(first === "revision" ? ["revision", "approval"] : ["approval"]);
      expect(results[first === "revision" ? 0 : 1]).toBe(first === "revision");
    } finally {
      release.resolve();
      await manager.closeAgent(agent.id);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("a review claim protects its own plan but does not block a later plan", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "plan-review-scope-"));
  const logger = createTestLogger();
  const manager = new AgentManager({ clients: { codex: createTestAgentClient("codex") }, logger });
  const agent = await manager.createAgent({ provider: "codex", cwd: directory }, undefined, {
    workspaceId: "workspace",
  });
  try {
    for (const callId of ["old", "new"])
      agent.pendingPermissions.set(callId, {
        id: callId,
        provider: "codex",
        name: "Plan",
        kind: "plan",
        sourcePlanCallId: callId,
      });
    await manager.setPlanReviewClaim({
      agentId: agent.id,
      workspaceId: "workspace",
      callId: "old",
      permissionRequestId: "old",
      active: true,
    });
    await expect(
      manager.respondToPermission(agent.id, "new", { behavior: "allow" }),
    ).resolves.toBeUndefined();
    await expect(
      manager.respondToPermission(agent.id, "old", { behavior: "allow" }),
    ).rejects.toThrow("review");
    expect(manager.getAgent(agent.id)!.planReviewClaims).toEqual({ old: "old" });
  } finally {
    await manager.closeAgent(agent.id);
    await rm(directory, { recursive: true, force: true });
  }
});
