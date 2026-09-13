import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage, parseStoredAgentRecord } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import type { AgentSession, AgentStreamEvent } from "./agent-sdk-types.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

const proposal = (text = "Plan A", turnId: string | undefined = "planning"): AgentStreamEvent => ({
  type: "timeline",
  provider: "codex",
  turnId,
  item: {
    type: "tool_call",
    callId: "plan",
    name: "proposal",
    status: "completed",
    error: null,
    detail: { type: "plan", text },
  },
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "synthetic-plan-"));
  const logger = createTestLogger();
  const history: AgentStreamEvent[] = [
    {
      type: "timeline",
      provider: "codex",
      turnId: "planning",
      item: { type: "user_message", text: "Build the feature" },
    },
    proposal(),
  ];
  const client = createTestAgentClient("codex");
  const wrap = (session: AgentSession) => {
    session.streamHistory = async function* () {
      yield* history;
    };
    return session;
  };
  const create = client.createSession.bind(client);
  const resume = client.resumeSession.bind(client);
  client.createSession = async (...args) => wrap(await create(...args));
  client.resumeSession = async (...args) => wrap(await resume(...args));
  const storage = new AgentStorage(directory, logger);
  const manager = new AgentManager({
    registry: storage,
    clients: { codex: client },
    logger,
    resolveLaunchProfile: () => ({
      id: "planner",
      name: "Planner",
      provider: "codex",
      postApprovalModeId: "full-access",
    }),
  });
  const reloadedStorage = new AgentStorage(directory, logger);
  const reloaded = new AgentManager({
    registry: reloadedStorage,
    clients: { codex: client },
    logger,
  });
  const agent = await manager.createAgent(
    { provider: "codex", cwd: directory, modeId: "plan" },
    undefined,
    { workspaceId: "workspace", launchProfileId: "planner" },
  );
  await manager.hydrateTimelineFromProvider(agent.id, { force: true });
  const input = { agentId: agent.id, workspaceId: "workspace", callId: "plan" };
  return {
    manager,
    reloaded,
    storage,
    history,
    agent,
    input,
    restart: async () => {
      await manager.closeAgent(agent.id);
      return ensureAgentLoaded(agent.id, {
        agentManager: reloaded,
        agentStorage: reloadedStorage,
        logger,
      });
    },
    close: async () => {
      await manager.closeAgent(agent.id);
      await reloaded.closeAgent(agent.id);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("synthetic approval rejects changed canonical text before mode, decision or prompt", async () => {
  const f = await fixture();
  try {
    const permission = await f.manager.ensurePlanPermission(f.input);
    const changed = proposal("Plan B");
    if (changed.type !== "timeline") throw new Error("fixture");
    await f.manager.appendTimelineItem(f.agent.id, changed.item);
    const delivered: string[] = [];
    await expect(
      f.manager.respondToPermission(
        f.agent.id,
        permission.id,
        { behavior: "allow" },
        async (prompt) => {
          delivered.push(prompt);
        },
      ),
    ).rejects.toThrow("changed");
    expect(delivered).toEqual([]);
    expect(await f.agent.session.getCurrentMode()).toBe("plan");
    expect((await f.storage.get(f.agent.id))?.config?.modeId).toBe("plan");
    expect(
      f.manager
        .getTimeline(f.agent.id)
        .some((item) => item.type === "tool_call" && item.metadata?.approved !== undefined),
    ).toBe(false);
    expect(f.agent.pendingPermissions.get(permission.id)?.input).toEqual({ plan: "Plan A" });
  } finally {
    await f.close();
  }
});

test.each(["deny", "allow", "unknown"] as const)(
  "synthetic %s decision survives force hydration and a new daemon manager",
  async (behavior) => {
    const f = await fixture();
    try {
      const permission = await f.manager.ensurePlanPermission(f.input);
      const reply = f.manager.respondToPermission(
        f.agent.id,
        permission.id,
        { behavior: behavior === "deny" ? "deny" : "allow" },
        async () => {
          if (behavior === "unknown") throw new Error("ACK lost");
        },
      );
      if (behavior === "unknown") await expect(reply).rejects.toThrow("outcome_unknown");
      else await reply;
      await f.manager.hydrateTimelineFromProvider(f.agent.id, { force: true });
      await expect(f.manager.ensurePlanPermission(f.input)).rejects.toThrow("resolved");
      const restored = () =>
        f.reloaded
          .getTimeline(f.agent.id)
          .filter(
            (item) =>
              item.type === "tool_call" && item.metadata?.syntheticPermissionId === permission.id,
          );
      await f.restart();
      await expect(f.reloaded.ensurePlanPermission(f.input)).rejects.toThrow("resolved");
      expect(restored()).toHaveLength(1);
      expect(restored()[0]).toMatchObject({
        metadata: {
          approved: behavior !== "deny",
          approvalOutcome: behavior === "unknown" ? "outcome_unknown" : "completed",
        },
      });
      f.history.splice(1);
      await f.reloaded.hydrateTimelineFromProvider(f.agent.id, { force: true });
      expect(restored()).toEqual([]);
      await expect(f.reloaded.ensurePlanPermission(f.input)).rejects.toThrow("resolved");
      f.history.push(proposal("Plan B"));
      await f.reloaded.hydrateTimelineFromProvider(f.agent.id, { force: true });
      expect(restored()).toEqual([]);
      await expect(f.reloaded.ensurePlanPermission(f.input)).rejects.toThrow("changed");
      f.history[1] = proposal("Plan A", "another-source-turn");
      await f.reloaded.hydrateTimelineFromProvider(f.agent.id, { force: true });
      expect(restored()).toEqual([]);
      await expect(f.reloaded.ensurePlanPermission(f.input)).rejects.toThrow("changed");
    } finally {
      await f.close();
    }
  },
);

test("the synthetic decision is on disk before approval mode or followup execution", async () => {
  const f = await fixture();
  try {
    const permission = await f.manager.ensurePlanPermission(f.input);
    const observed: string[] = [];
    const assertDurable = async (effect: string) => {
      const freshStorage = new AgentStorage(f.agent.cwd, createTestLogger());
      expect((await freshStorage.get(f.agent.id))?.syntheticPlanDecisions?.plan).toMatchObject({
        text: "Plan A",
        permissionId: permission.id,
        resolution: { behavior: "allow" },
        outcome: "pending",
      });
      observed.push(effect);
    };
    const setMode = f.agent.session.setMode.bind(f.agent.session);
    f.agent.session.setMode = async (mode) => {
      await assertDurable("mode");
      return setMode(mode);
    };
    await f.manager.respondToPermission(
      f.agent.id,
      permission.id,
      { behavior: "allow" },
      async () => {
        await assertDurable("prompt");
      },
    );
    expect(observed).toEqual(["mode", "prompt"]);
  } finally {
    await f.close();
  }
});

test("provider history retains its optional turnId on force hydration and daemon restart", async () => {
  const f = await fixture();
  try {
    await f.manager.runAgent(f.agent.id, "Respond with exactly: Implementation finished");
    const completed = f.manager.getAgent(f.agent.id)!.lastCompletedTurnId!;
    f.history.push(
      {
        type: "timeline",
        provider: "codex",
        turnId: completed,
        item: { type: "user_message", text: "Implement", clientMessageId: "implementation" },
      },
      {
        type: "timeline",
        provider: "codex",
        turnId: completed,
        item: { type: "assistant_message", text: "Implementation finished" },
      },
      {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "Legacy without causal evidence" },
      },
    );
    await f.manager.hydrateTimelineFromProvider(f.agent.id, { force: true });
    expect((await f.manager.getTimelineRows(f.agent.id)).map((row) => row.turnId)).toEqual([
      "planning",
      "planning",
      completed,
      completed,
      undefined,
    ]);
    const resumed = await f.restart();
    expect(resumed.lastCompletedTurnId).toBe(completed);
    expect((await f.reloaded.getTimelineRows(f.agent.id)).map((row) => row.turnId)).toEqual([
      "planning",
      "planning",
      completed,
      completed,
      undefined,
    ]);
    const stored = await f.storage.get(f.agent.id);
    expect(
      parseStoredAgentRecord({ ...stored, syntheticPlanDecisions: undefined }).lastCompletedTurnId,
    ).toBe(completed);
  } finally {
    await f.close();
  }
});
