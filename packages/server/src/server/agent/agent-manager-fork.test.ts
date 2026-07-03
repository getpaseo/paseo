import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { AgentManager } from "./agent-manager.js";

function createManager(clients = createTestAgentClients()): AgentManager {
  return new AgentManager({
    clients,
    providerDefinitions: {
      claude: { enabled: true },
      codex: { enabled: true },
      opencode: { enabled: true },
    },
    logger: createTestLogger(),
  });
}

test("forkAgent creates an independent parallel session that preserves full context", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "paseo-fork-test-"));
  try {
    const manager = createManager();
    const source = await manager.createAgent({ provider: "claude", cwd });
    await manager.runAgent(source.id, "say 'state saved'");

    const sourceRowsBefore = await manager.getTimelineRows(source.id);
    expect(sourceRowsBefore.length).toBeGreaterThan(0);
    const sourceSessionId = manager.getAgent(source.id)?.persistence?.sessionId;
    expect(sourceSessionId).toBeTruthy();

    const fork = await manager.forkAgent(source.id);

    // Distinct managed agent + distinct provider session (real fork mints a new id).
    expect(fork.id).not.toBe(source.id);
    expect(fork.persistence?.sessionId).toBeTruthy();
    expect(fork.persistence?.sessionId).not.toBe(sourceSessionId);
    expect(fork.labels.forkedFromAgentId).toBe(source.id);
    // No cosmetic snapshot mode — this is a real provider fork.
    expect(fork.labels.forkMode).toBeUndefined();

    // Source untouched + BOTH live in parallel.
    const ids = manager.listAgents().map((a) => a.id);
    expect(ids).toContain(source.id);
    expect(ids).toContain(fork.id);
    expect(manager.getAgent(source.id)?.persistence?.sessionId).toBe(sourceSessionId);
    expect(manager.getAgent(source.id)?.lifecycle).not.toBe("closed");
    expect(manager.getAgent(fork.id)?.lifecycle).not.toBe("closed");

    // Fork is seeded with the FULL source context (not a truncated view).
    const forkRows = await manager.getTimelineRows(fork.id);
    expect(forkRows.map((r) => r.item)).toEqual(sourceRowsBefore.map((r) => r.item));

    // Both run independently afterwards.
    await manager.runAgent(fork.id, "say 'timeline test'");
    await manager.runAgent(source.id, "say 'state saved'");
    expect(manager.getAgent(source.id)?.persistence?.sessionId).toBe(sourceSessionId);
    expect(manager.getAgent(fork.id)?.persistence?.sessionId).not.toBe(sourceSessionId);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("forkAgent throws for a provider that does not support a real fork (no snapshot fallback)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "paseo-fork-nofork-"));
  try {
    // Disable native fork on this provider for this manager instance.
    const clients = createTestAgentClients({ claude: { supportsFork: false } });
    const manager = createManager(clients);
    const source = await manager.createAgent({ provider: "claude", cwd });
    await manager.runAgent(source.id, "say 'state saved'");

    await expect(manager.forkAgent(source.id)).rejects.toThrow(/does not support forking/);
    // Source remains the only agent — no meaningless snapshot agent was created.
    expect(manager.listAgents().map((a) => a.id)).toEqual([source.id]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("forkAgent throws when the agent has no persisted session", async () => {
  const manager = createManager();
  await expect(manager.forkAgent("00000000-0000-4000-8000-000000000000")).rejects.toThrow();
});
