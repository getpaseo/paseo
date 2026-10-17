import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AUTO_RESUME_USAGE_LIMIT_LABEL } from "@getpaseo/protocol/agent-usage-limit";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { MockLoadTestAgentClient } from "./providers/mock-load-test-agent.js";
import { UsageLimitResumeService } from "./usage-limit-resume.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

async function setup(resetsAt: string | null = new Date(Date.now() - 120_000).toISOString()) {
  const home = await mkdtemp(path.join(tmpdir(), "usage-limit-test-"));
  const logger = createTestLogger();
  let registry = new AgentStorage(path.join(home, "agents"), logger);
  let manager = new AgentManager({
    clients: { mock: new MockLoadTestAgentClient(logger) },
    registry,
    logger,
  });
  const agent = await manager.createAgent(
    {
      provider: "mock",
      cwd: home,
      model: "e2e-fast-stream",
      featureValues: { mockAssistantResponse: "Task resumed." },
    },
    undefined,
    { workspaceId: "usage-limit-test-workspace" },
  );
  await expect(
    manager.runAgent(agent.id, `Emit synthetic usage limit: ${resetsAt ?? "unknown"}`),
  ).rejects.toThrow("Usage limit reached");
  await manager.flushForShutdown();
  const originalHandle = (await registry.get(agent.id))?.persistence;
  const createService = (allowed = true) =>
    new UsageLimitResumeService({
      agentStorage: registry,
      agentManager: manager,
      logger,
      canResumeWorkspace: async () => allowed,
    });
  const closeManager = async () => {
    manager.prepareForShutdown();
    for (const item of manager.listAgents()) await manager.closeAgent(item.id);
    await manager.flushForShutdown();
  };
  cleanup.push(async () => {
    await closeManager();
    await rm(home, { recursive: true, force: true });
  });
  return {
    get registry() {
      return registry;
    },
    agentId: agent.id,
    originalHandle,
    createService,
    get manager() {
      return manager;
    },
    restart: async () => {
      await closeManager();
      registry = new AgentStorage(path.join(home, "agents"), logger);
      manager = new AgentManager({
        clients: { mock: new MockLoadTestAgentClient(logger) },
        registry,
        logger,
      });
    },
    enable: () =>
      manager.updateAgentMetadata(agent.id, {
        labels: { [AUTO_RESUME_USAGE_LIMIT_LABEL]: "true" },
      }),
  };
}

function resumedMessages(manager: AgentManager, agentId: string) {
  if (!manager.getAgent(agentId)) return [];
  return manager
    .getTimeline(agentId)
    .filter(
      (item) => item.type === "user_message" && item.text.startsWith("The usage limit reset."),
    );
}

test("opt-in is required; concurrent scans resume once in the same provider session", async () => {
  const fixture = await setup();
  const service = fixture.createService();
  await service.tick();
  expect(resumedMessages(fixture.manager, fixture.agentId)).toHaveLength(0);
  await fixture.enable();
  await Promise.all([service.tick(), service.tick()]);
  await expect
    .poll(() => fixture.manager.getLastAssistantMessage(fixture.agentId))
    .toBe("Task resumed.");
  await fixture.manager.flushForShutdown();
  await service.tick();
  expect(resumedMessages(fixture.manager, fixture.agentId)).toHaveLength(1);
  expect((await fixture.registry.get(fixture.agentId))?.persistence).toEqual(
    fixture.originalHandle,
  );
  expect((await fixture.registry.get(fixture.agentId))?.usageLimit).toBeUndefined();
});

test("an overdue opted-in wait survives a daemon restart", async () => {
  const fixture = await setup();
  await fixture.enable();
  await fixture.restart();
  await fixture.createService().tick();
  await expect
    .poll(() => fixture.manager.getLastAssistantMessage(fixture.agentId))
    .toBe("Task resumed.");
  expect(resumedMessages(fixture.manager, fixture.agentId)).toHaveLength(1);
  expect(fixture.manager.getAgent(fixture.agentId)?.persistence).toEqual(fixture.originalHandle);
});

test.each([
  null,
  new Date(Date.now() + 3_600_000).toISOString(),
  new Date(Date.now() - 30_000).toISOString(),
])("does not retry before a known reset plus buffer: %s", async (resetsAt) => {
  const fixture = await setup(resetsAt);
  await fixture.enable();
  await fixture.createService().tick();
  expect(resumedMessages(fixture.manager, fixture.agentId)).toHaveLength(0);
});

test.each(["disabled", "manual", "archived", "workspace-blocked", "shutdown"])(
  "cancels unattended continuation when %s",
  async (reason) => {
    const fixture = await setup();
    await fixture.enable();
    if (reason === "disabled")
      await fixture.manager.updateAgentMetadata(fixture.agentId, {
        labels: { [AUTO_RESUME_USAGE_LIMIT_LABEL]: "false" },
      });
    if (reason === "manual")
      await fixture.manager.runAgent(fixture.agentId, "I will continue myself");
    if (reason === "archived") await fixture.manager.archiveAgent(fixture.agentId);
    if (reason === "shutdown") fixture.manager.prepareForShutdown();
    await fixture.manager.flushForShutdown();
    if (reason === "archived")
      expect((await fixture.registry.get(fixture.agentId))?.usageLimit).toBeUndefined();
    await fixture.createService(reason !== "workspace-blocked").tick();
    expect(resumedMessages(fixture.manager, fixture.agentId)).toHaveLength(0);
  },
);

test("a manual turn completing during a slow durable claim cancels continuation", async () => {
  const fixture = await setup();
  await fixture.enable();
  const claimed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const applySnapshot = fixture.registry.applySnapshot.bind(fixture.registry);
  const write = vi
    .spyOn(fixture.registry, "applySnapshot")
    .mockImplementationOnce(async (agent, options) => {
      await applySnapshot(agent, options);
      claimed.resolve();
      await release.promise;
    });
  const tick = fixture.createService().tick();
  try {
    await claimed.promise;
    await fixture.manager.runAgent(fixture.agentId, "Continue manually while saving");
  } finally {
    release.resolve();
    await tick;
    write.mockRestore();
  }
  expect(resumedMessages(fixture.manager, fixture.agentId)).toHaveLength(0);
  expect(await fixture.manager.getLastAssistantMessage(fixture.agentId)).toBe("Task resumed.");
});
