import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { recoverInterruptedAgents } from "./agent-recovery.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentClient } from "./agent-sdk-types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createInterruptedAgentFixture(): Promise<{
  agentId: string;
  storage: AgentStorage;
  workdir: string;
}> {
  const workdir = await mkdtemp(path.join(tmpdir(), "paseo-agent-recovery-"));
  roots.push(workdir);
  const storage = new AgentStorage(path.join(workdir, "agents"), createTestLogger());
  await storage.initialize();
  const manager = new AgentManager({
    clients: { codex: createTestAgentClient("codex") },
    registry: storage,
    logger: createTestLogger(),
    idFactory: () => "11111111-1111-4111-8111-111111111111",
  });
  const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  await storage.applySnapshot(agent);
  await manager.closeAgent(agent.id);
  const record = await storage.get(agent.id);
  if (!record) {
    throw new Error("Expected persisted agent record");
  }
  await storage.upsert({
    ...record,
    lastStatus: "running",
    persistence: {
      provider: "codex",
      sessionId: "recovery-session",
      metadata: { cwd: workdir },
    },
  });

  return { agentId: agent.id, storage, workdir };
}

function createRecoveryManager(storage: AgentStorage, client: AgentClient): AgentManager {
  return new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger: createTestLogger(),
  });
}

test("resumes interrupted persisted agents before clients connect", async () => {
  const fixture = await createInterruptedAgentFixture();
  const manager = createRecoveryManager(fixture.storage, createTestAgentClient("codex"));

  await recoverInterruptedAgents({
    agentManager: manager,
    agentStorage: fixture.storage,
    logger: createTestLogger(),
  });

  expect(manager.getAgent(fixture.agentId)?.persistence).toMatchObject({
    provider: "codex",
  });
});

test("marks an unrecoverable interrupted agent as an attention error without retrying it", async () => {
  const fixture = await createInterruptedAgentFixture();
  const delegate = createTestAgentClient("codex");
  const failingClient: AgentClient = {
    provider: delegate.provider,
    capabilities: delegate.capabilities,
    createSession: delegate.createSession.bind(delegate),
    resumeSession: async () => {
      throw new Error("conversation no longer exists");
    },
    fetchCatalog: delegate.fetchCatalog.bind(delegate),
    isAvailable: delegate.isAvailable.bind(delegate),
  };
  const manager = createRecoveryManager(fixture.storage, failingClient);

  await recoverInterruptedAgents({
    agentManager: manager,
    agentStorage: fixture.storage,
    logger: createTestLogger(),
  });

  await recoverInterruptedAgents({
    agentManager: manager,
    agentStorage: fixture.storage,
    logger: createTestLogger(),
  });

  expect(await fixture.storage.get(fixture.agentId)).toMatchObject({
    lastStatus: "error",
    requiresAttention: true,
    attentionReason: "error",
    lastError:
      "Paseo could not resume this agent after the daemon restart: conversation no longer exists",
  });
});

test("marks an interrupted agent without a persistence handle as unrecoverable", async () => {
  const fixture = await createInterruptedAgentFixture();
  const record = await fixture.storage.get(fixture.agentId);
  if (!record) {
    throw new Error("Expected persisted agent record");
  }
  await fixture.storage.upsert({ ...record, persistence: null });
  const manager = createRecoveryManager(fixture.storage, createTestAgentClient("codex"));

  await recoverInterruptedAgents({
    agentManager: manager,
    agentStorage: fixture.storage,
    logger: createTestLogger(),
  });

  expect(await fixture.storage.get(fixture.agentId)).toMatchObject({
    lastStatus: "error",
    requiresAttention: true,
    attentionReason: "error",
    lastError:
      "Paseo could not resume this agent after the daemon restart: the codex conversation is not resumable on this daemon",
  });
});

test("does not resume an agent whose cancellation was interrupted by the restart", async () => {
  const fixture = await createInterruptedAgentFixture();
  const record = await fixture.storage.get(fixture.agentId);
  if (!record) {
    throw new Error("Expected persisted agent record");
  }
  // A cancellation acknowledged by the daemon but killed before the resulting
  // idle transition could be written: the record still reads "running".
  await fixture.storage.upsert({
    ...record,
    cancelRequestedAt: new Date().toISOString(),
  });
  const manager = createRecoveryManager(fixture.storage, createTestAgentClient("codex"));

  await recoverInterruptedAgents({
    agentManager: manager,
    agentStorage: fixture.storage,
    logger: createTestLogger(),
  });

  expect(manager.getAgent(fixture.agentId)).toBeNull();
  expect(await fixture.storage.get(fixture.agentId)).toMatchObject({
    lastStatus: "idle",
    cancelRequestedAt: null,
  });
});

test("stops retrying a candidate that never finishes its recovery attempt", async () => {
  const fixture = await createInterruptedAgentFixture();
  const delegate = createTestAgentClient("codex");
  // Simulates a candidate that takes the daemon down mid-recovery: the failure
  // path never runs, so the record keeps its "running" status every boot.
  const crashingClient: AgentClient = {
    provider: delegate.provider,
    capabilities: delegate.capabilities,
    createSession: delegate.createSession.bind(delegate),
    resumeSession: async () => {
      throw new Error("daemon died mid-recovery");
    },
    fetchCatalog: delegate.fetchCatalog.bind(delegate),
    isAvailable: delegate.isAvailable.bind(delegate),
  };

  for (let boot = 0; boot < 5; boot += 1) {
    const manager = createRecoveryManager(fixture.storage, crashingClient);
    const record = await fixture.storage.get(fixture.agentId);
    if (!record) {
      throw new Error("Expected persisted agent record");
    }
    // Re-arm the interrupted status the way an unclean shutdown would.
    await fixture.storage.upsert({ ...record, lastStatus: "running", lastError: null });
    await recoverInterruptedAgents({
      agentManager: manager,
      agentStorage: fixture.storage,
      logger: createTestLogger(),
    });
  }

  expect(await fixture.storage.get(fixture.agentId)).toMatchObject({
    lastStatus: "error",
    requiresAttention: true,
    lastError:
      "Paseo could not resume this agent after the daemon restart: recovery was attempted 3 times without succeeding",
  });
});

test("preserves recovery bookkeeping across a snapshot flush", async () => {
  const fixture = await createInterruptedAgentFixture();
  const record = await fixture.storage.get(fixture.agentId);
  if (!record) {
    throw new Error("Expected persisted agent record");
  }
  await fixture.storage.upsert({
    ...record,
    cancelRequestedAt: "2026-01-01T00:00:00.000Z",
    recoveryAttempts: 2,
  });

  const manager = createRecoveryManager(fixture.storage, createTestAgentClient("codex"));
  const agent = await manager.createAgent({ provider: "codex", cwd: fixture.workdir }, undefined, {
    workspaceId: undefined,
  });
  // The projection is built from live agent state, which knows nothing about
  // these fields; without explicit preservation the flush would drop them.
  await fixture.storage.applySnapshot({ ...agent, id: fixture.agentId });

  expect(await fixture.storage.get(fixture.agentId)).toMatchObject({
    cancelRequestedAt: "2026-01-01T00:00:00.000Z",
    recoveryAttempts: 2,
  });
});
