import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AUTO_RESUME_USAGE_LIMIT_LABEL } from "@getpaseo/protocol/agent-usage-limit";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { MockLoadTestAgentClient } from "./providers/mock-load-test-agent.js";
import { UsageLimitResumeService } from "./usage-limit-resume.js";

interface PausedOperation {
  entered: Promise<void>;
  release: () => void;
}

class OperationGate {
  private readonly started = Promise.withResolvers<void>();
  private readonly released = Promise.withResolvers<void>();

  get control(): PausedOperation {
    return { entered: this.started.promise, release: () => this.released.resolve() };
  }

  async wait(): Promise<void> {
    this.started.resolve();
    await this.released.promise;
  }
}

// Keep real JSON persistence, with an injected failure/pause at the storage boundary.
class ControlledAgentStorage extends AgentStorage {
  private snapshotGate: OperationGate | null = null;
  private snapshotError: Error | null = null;

  pauseNextSnapshot(): PausedOperation {
    const gate = new OperationGate();
    this.snapshotGate = gate;
    return gate.control;
  }

  failNextSnapshot(): void {
    this.snapshotError = new Error("Injected snapshot write failure");
  }

  override async applySnapshot(...args: Parameters<AgentStorage["applySnapshot"]>): Promise<void> {
    const gate = this.snapshotGate;
    const error = this.snapshotError;
    this.snapshotGate = null;
    this.snapshotError = null;
    if (gate) await gate.wait();
    if (error) throw error;
    await super.applySnapshot(...args);
  }
}

class ControlledMockClient extends MockLoadTestAgentClient {
  private resumeGate: OperationGate | null = null;

  pauseNextResume(): PausedOperation {
    const gate = new OperationGate();
    this.resumeGate = gate;
    return gate.control;
  }

  override async resumeSession(...args: Parameters<MockLoadTestAgentClient["resumeSession"]>) {
    const gate = this.resumeGate;
    this.resumeGate = null;
    if (gate) await gate.wait();
    return super.resumeSession(...args);
  }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

interface SetupInput {
  resetsAt?: string | null;
}

interface CreateServiceInput {
  workspaceAllowed?: boolean;
}

async function setup({ resetsAt = new Date(Date.now() - 120_000).toISOString() }: SetupInput = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "usage-limit-test-"));
  const logger = createTestLogger();
  let registry = new ControlledAgentStorage(path.join(home, "agents"), logger);
  let provider = new ControlledMockClient(logger);
  let manager = new AgentManager({
    clients: { mock: provider },
    registry,
    logger,
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
  function createService({ workspaceAllowed = true }: CreateServiceInput = {}) {
    return new UsageLimitResumeService({
      agentStorage: registry,
      agentManager: manager,
      logger,
      canResumeWorkspace: async () => workspaceAllowed,
    });
  }
  return {
    get provider() {
      return provider;
    },
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
      registry = new ControlledAgentStorage(path.join(home, "agents"), logger);
      provider = new ControlledMockClient(logger);
      manager = new AgentManager({
        clients: { mock: provider },
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

type UsageLimitFixture = Awaited<ReturnType<typeof setup>>;

function resumedMessages({ manager, agentId }: UsageLimitFixture) {
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
  expect(resumedMessages(fixture)).toHaveLength(0);
  await fixture.enable();
  await Promise.all([service.tick(), service.tick()]);
  await expect
    .poll(() => fixture.manager.getLastAssistantMessage(fixture.agentId))
    .toBe("Task resumed.");
  await fixture.manager.flushForShutdown();
  await service.tick();
  expect(resumedMessages(fixture)).toHaveLength(1);
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
  expect(resumedMessages(fixture)).toHaveLength(1);
  expect(fixture.manager.getAgent(fixture.agentId)?.persistence).toEqual(fixture.originalHandle);
});

test.each([
  null,
  new Date(Date.now() + 3_600_000).toISOString(),
  new Date(Date.now() - 30_000).toISOString(),
])("does not retry before a known reset plus buffer: %s", async (resetsAt) => {
  const fixture = await setup({ resetsAt });
  await fixture.enable();
  await fixture.createService().tick();
  expect(resumedMessages(fixture)).toHaveLength(0);
});

test("disabling the preference cancels unattended continuation", async () => {
  const fixture = await setup();
  await fixture.enable();
  await fixture.manager.updateAgentMetadata(fixture.agentId, {
    labels: { [AUTO_RESUME_USAGE_LIMIT_LABEL]: "false" },
  });
  await fixture.createService().tick();
  expect(resumedMessages(fixture)).toHaveLength(0);
});

test("a manual continuation cancels the pending wait", async () => {
  const fixture = await setup();
  await fixture.enable();
  await fixture.manager.runAgent(fixture.agentId, "I will continue myself");
  await fixture.createService().tick();
  expect(resumedMessages(fixture)).toHaveLength(0);
});

test("archiving clears the durable wait and prevents continuation", async () => {
  const fixture = await setup();
  await fixture.enable();
  await fixture.manager.archiveAgent(fixture.agentId);
  await fixture.createService().tick();
  expect((await fixture.registry.get(fixture.agentId))?.usageLimit).toBeUndefined();
  expect(fixture.manager.getAgent(fixture.agentId)).toBeNull();
});

test("a blocked workspace prevents unattended continuation", async () => {
  const fixture = await setup();
  await fixture.enable();
  await fixture.createService({ workspaceAllowed: false }).tick();
  expect(resumedMessages(fixture)).toHaveLength(0);
});

test("shutdown prevents unattended continuation", async () => {
  const fixture = await setup();
  await fixture.enable();
  fixture.manager.prepareForShutdown();
  await fixture.createService().tick();
  expect(resumedMessages(fixture)).toHaveLength(0);
});

test("a manual turn completing during a slow durable claim cancels continuation", async () => {
  const fixture = await setup();
  await fixture.enable();
  const claim = fixture.registry.pauseNextSnapshot();
  const tick = fixture.createService().tick();
  try {
    await claim.entered;
    await fixture.manager.runAgent(fixture.agentId, "Continue manually while saving");
  } finally {
    claim.release();
    await tick;
  }
  expect(resumedMessages(fixture)).toHaveLength(0);
  expect(await fixture.manager.getLastAssistantMessage(fixture.agentId)).toBe("Task resumed.");
});

test("switch-off received during a durable claim prevents automatic dispatch", async () => {
  const fixture = await setup();
  await fixture.enable();
  const claim = fixture.registry.pauseNextSnapshot();
  const tick = fixture.createService().tick();
  await claim.entered;
  const disable = fixture.manager.updateAgentMetadata(fixture.agentId, {
    labels: { [AUTO_RESUME_USAGE_LIMIT_LABEL]: "false" },
  });
  claim.release();
  await Promise.all([tick, disable]);
  await fixture.manager.flushForShutdown();
  expect(resumedMessages(fixture)).toHaveLength(0);
  expect((await fixture.registry.get(fixture.agentId))?.labels[AUTO_RESUME_USAGE_LIMIT_LABEL]).toBe(
    "false",
  );
});

test("switch-off received during cold provider recovery prevents automatic dispatch", async () => {
  const fixture = await setup();
  await fixture.enable();
  await fixture.restart();
  const recovery = fixture.provider.pauseNextResume();
  const tick = fixture.createService().tick();
  await recovery.entered;
  const disable = fixture.manager.updateAgentMetadata(fixture.agentId, {
    labels: { [AUTO_RESUME_USAGE_LIMIT_LABEL]: "false" },
  });
  recovery.release();
  await Promise.all([tick, disable]);
  await fixture.manager.flushForShutdown();
  expect(resumedMessages(fixture)).toHaveLength(0);
  expect((await fixture.registry.get(fixture.agentId))?.labels[AUTO_RESUME_USAGE_LIMIT_LABEL]).toBe(
    "false",
  );
});

test("a failed durable claim preserves the wait and retries after storage recovers", async () => {
  const fixture = await setup();
  await fixture.enable();
  const originalLimit = (await fixture.registry.get(fixture.agentId))?.usageLimit;
  fixture.registry.failNextSnapshot();
  const service = fixture.createService();
  await service.tick();
  expect(resumedMessages(fixture)).toHaveLength(0);
  expect(fixture.manager.getAgent(fixture.agentId)?.usageLimit).toEqual(originalLimit);
  expect((await fixture.registry.get(fixture.agentId))?.usageLimit).toEqual(originalLimit);
  await service.tick();
  await expect
    .poll(() => fixture.manager.getLastAssistantMessage(fixture.agentId))
    .toBe("Task resumed.");
  await service.tick();
  expect(resumedMessages(fixture)).toHaveLength(1);
});

test("a failed claim does not restore a wait replaced by manual continuation", async () => {
  const fixture = await setup();
  await fixture.enable();
  fixture.registry.failNextSnapshot();
  const claim = fixture.registry.pauseNextSnapshot();
  const service = fixture.createService();
  const tick = service.tick();
  try {
    await claim.entered;
    await fixture.manager.runAgent(fixture.agentId, "Continue manually during the failed save");
  } finally {
    claim.release();
    await tick;
  }
  await service.tick();
  expect(resumedMessages(fixture)).toHaveLength(0);
  expect(fixture.manager.getAgent(fixture.agentId)?.usageLimit).toBeUndefined();
  expect((await fixture.registry.get(fixture.agentId))?.usageLimit).toBeUndefined();
});

test("a failed claim preserves a newer usage limit from a manual turn", async () => {
  const fixture = await setup();
  await fixture.enable();
  fixture.registry.failNextSnapshot();
  const claim = fixture.registry.pauseNextSnapshot();
  const tick = fixture.createService().tick();
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  try {
    await claim.entered;
    await expect(
      fixture.manager.runAgent(fixture.agentId, `Emit synthetic usage limit: ${resetsAt}`),
    ).rejects.toThrow("Usage limit reached");
  } finally {
    claim.release();
    await tick;
  }
  expect(resumedMessages(fixture)).toHaveLength(0);
  expect(fixture.manager.getAgent(fixture.agentId)?.usageLimit).toEqual({ resetsAt });
});

test("archiving during cold recovery cancels continuation before its durable archive", async () => {
  const fixture = await setup();
  await fixture.enable();
  await fixture.restart();
  const before = await fixture.registry.get(fixture.agentId);
  const recovery = fixture.provider.pauseNextResume();
  const tick = fixture.createService().tick();
  await recovery.entered;
  const archive = fixture.manager.archiveSnapshot(fixture.agentId, new Date().toISOString());
  recovery.release();
  await Promise.all([tick, archive]);
  const after = await fixture.registry.get(fixture.agentId);
  expect(after?.lastUserMessageAt).toBe(before?.lastUserMessageAt);
  expect(after?.usageLimit).toBeUndefined();
  expect(fixture.manager.getAgent(fixture.agentId)).toBeNull();
});
