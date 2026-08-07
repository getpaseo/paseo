/**
 * Integration coverage for NEW-1: a real ACP child process whose initialize
 * handshake hangs must not pin session close or daemon shutdown. Exercises
 * the real spawn path, the real on-disk managed process ledger, tree-kill
 * termination, and the AgentManager layer that closeAllAgents awaits.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { ACPAgentClient } from "./acp-agent.js";
import { AgentManager } from "../agent-manager.js";
import {
  createManagedProcessRegistry,
  createSystemManagedProcessTable,
  type ManagedProcessRegistry,
} from "../../managed-processes/managed-processes.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { terminateWithTreeKill } from "../../../utils/tree-kill.js";

const logger = createTestLogger();

/**
 * Minimal ACP host over NDJSON stdio. Responds to the first initialize and
 * hangs every later one (tracked via a counter file), or hangs all of them
 * when hangAll is baked in. Everything else gets a canned response.
 */
function mockACPSource(options: {
  counterFile: string;
  hangAll: boolean;
  hangSessionLoad: boolean;
}): string {
  return `
const readline = require("node:readline");
const fs = require("node:fs");
const COUNTER_FILE = ${JSON.stringify(options.counterFile)};
const HANG_ALL = ${JSON.stringify(options.hangAll)};
const HANG_SESSION_LOAD = ${JSON.stringify(options.hangSessionLoad)};

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined || typeof msg.method !== "string") {
    return;
  }
  switch (msg.method) {
    case "initialize": {
      let count = 0;
      try {
        count = parseInt(fs.readFileSync(COUNTER_FILE, "utf8"), 10) || 0;
      } catch {}
      count += 1;
      fs.writeFileSync(COUNTER_FILE, String(count));
      if (HANG_ALL || count > 1) {
        return; // Hung handshake: never respond.
      }
      respond(msg.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [],
      });
      break;
    }
    case "session/new":
    case "session/load":
      if (msg.method === "session/load" && HANG_SESSION_LOAD) {
        return; // Hung attach: never respond.
      }
      respond(msg.id, {
        sessionId: "mock-session-1",
        modes: null,
        models: {
          availableModels: [{ modelId: "mock-model", name: "Mock Model" }],
          currentModelId: "mock-model",
        },
        configOptions: [],
      });
      break;
    case "session/prompt":
      respond(msg.id, { stopReason: "end_turn" });
      break;
    default:
      respond(msg.id, {});
  }
});
`;
}

interface IntegrationFixture {
  workdir: string;
  registry: ManagedProcessRegistry;
  mockPath: string;
  counterFile: string;
}

async function createFixture(options: {
  hangAll: boolean;
  hangSessionLoad?: boolean;
}): Promise<IntegrationFixture> {
  const workdir = await mkdtemp(path.join(tmpdir(), "paseo-acp-init-hang-"));
  const counterFile = path.join(workdir, "mock-initialize-count");
  await writeFile(counterFile, "0", "utf8");
  const mockPath = path.join(workdir, "mock-acp.cjs");
  await writeFile(
    mockPath,
    mockACPSource({
      counterFile,
      hangAll: options.hangAll,
      hangSessionLoad: options.hangSessionLoad ?? false,
    }),
    "utf8",
  );
  const registry = createManagedProcessRegistry({
    paseoHome: workdir,
    processTable: createSystemManagedProcessTable(),
    terminateProcess: terminateWithTreeKill,
    logger,
  });
  return { workdir, registry, mockPath, counterFile };
}

function createClient(
  fixture: IntegrationFixture,
  options: { initializeTimeoutMs?: number; sessionLoadTimeoutMs?: number } = {},
): ACPAgentClient {
  return new ACPAgentClient({
    provider: "claude-acp",
    logger,
    defaultCommand: [process.execPath, fixture.mockPath],
    defaultModes: [],
    managedProcesses: fixture.registry,
    ...(options.initializeTimeoutMs ? { initializeTimeoutMs: options.initializeTimeoutMs } : {}),
    ...(options.sessionLoadTimeoutMs ? { sessionLoadTimeoutMs: options.sessionLoadTimeoutMs } : {}),
  });
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForCondition(
  assertion: () => void | Promise<void>,
  timeoutMs = 10_000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt > timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

describe("ACP hung initialize integration (NEW-1)", () => {
  const fixtures: IntegrationFixture[] = [];

  afterEach(async () => {
    const fixture = fixtures.pop();
    if (fixture) {
      await rm(fixture.workdir, { recursive: true, force: true });
    }
  });

  test("AgentManager closeAgent completes when an ACP initialize hangs during respawn", async () => {
    const fixture = await createFixture({ hangAll: false });
    fixtures.push(fixture);
    const client = createClient(fixture); // default 30s initialize timeout: close must not wait for it
    const manager = new AgentManager({
      clients: { "claude-acp": client },
      logger,
    });

    const agent = await manager.createAgent(
      // An explicit model skips the fetchCatalog probe, so the first spawned
      // process is the session itself and the second one is the respawn.
      { provider: "claude-acp", cwd: fixture.workdir, model: "mock-model" },
      undefined,
      { workspaceId: undefined },
    );

    await waitForCondition(async () => {
      expect(await fixture.registry.list()).toHaveLength(1);
    });
    const [initialRecord] = await fixture.registry.list();
    const firstPid = initialRecord.pid;
    expect(firstPid).toBeGreaterThan(0);
    expect(pidIsAlive(firstPid)).toBe(true);

    // Crash the worker; the next prompt respawns and the second initialize hangs.
    process.kill(firstPid, "SIGKILL");
    await waitForCondition(() => {
      expect(pidIsAlive(firstPid)).toBe(false);
    });
    await waitForCondition(async () => {
      expect(await fixture.registry.list()).toHaveLength(0);
    });

    const stream = manager.streamAgent(agent.id, "revive after crash");
    const firstEvent = stream.next();
    firstEvent.catch(() => {});

    // The respawned process is registered in the ledger before its (hung)
    // initialize completes.
    let pendingPid = 0;
    await waitForCondition(async () => {
      const records = await fixture.registry.list();
      expect(records).toHaveLength(1);
      pendingPid = records[0]?.pid ?? 0;
      expect(records[0]?.metadata.stage).toBe("starting");
    });
    expect(pendingPid).toBeGreaterThan(0);
    expect(pendingPid).not.toBe(firstPid);
    expect(pidIsAlive(pendingPid)).toBe(true);

    // This is the call closeAllAgents makes during daemon shutdown.
    const closeStartedAt = Date.now();
    await manager.closeAgent(agent.id);
    const closeDurationMs = Date.now() - closeStartedAt;

    expect(closeDurationMs).toBeLessThan(15_000);
    await expect(firstEvent).rejects.toThrow(/closed/);

    // No child process and no ledger record survive the close.
    await waitForCondition(() => {
      expect(pidIsAlive(pendingPid)).toBe(false);
    });
    expect(await fixture.registry.list()).toHaveLength(0);

    // No late spawn, record, or process appears after the close.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await fixture.registry.list()).toHaveLength(0);

    // A "restarted daemon" reaping the same ledger finds nothing to clean up.
    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: fixture.workdir,
      processTable: createSystemManagedProcessTable(),
      terminateProcess: terminateWithTreeKill,
      logger,
    });
    await expect(restartedRegistry.reapStale()).resolves.toMatchObject({
      checked: 0,
      removed: 0,
      terminated: 0,
    });
  }, 60_000);

  test("initialize timeout kills the real spawned process and clears the ledger", async () => {
    const fixture = await createFixture({ hangAll: true });
    fixtures.push(fixture);
    const client = createClient(fixture, { initializeTimeoutMs: 1_000 });

    const createPromise = client.createSession({ provider: "claude-acp", cwd: fixture.workdir });
    createPromise.catch(() => {});

    // While initialize hangs, the process is already visible in the ledger.
    let pendingPid = 0;
    await waitForCondition(async () => {
      const records = await fixture.registry.list();
      expect(records).toHaveLength(1);
      pendingPid = records[0]?.pid ?? 0;
      expect(records[0]?.metadata.stage).toBe("starting");
    });
    expect(pidIsAlive(pendingPid)).toBe(true);

    const startedAt = Date.now();
    await expect(createPromise).rejects.toThrow("acp_initialize_timeout");
    expect(Date.now() - startedAt).toBeLessThan(15_000);

    await waitForCondition(() => {
      expect(pidIsAlive(pendingPid)).toBe(false);
    });
    expect(await fixture.registry.list()).toHaveLength(0);
  }, 60_000);

  test("session/load timeout during resume kills the real process and clears the ledger", async () => {
    const fixture = await createFixture({ hangAll: false, hangSessionLoad: true });
    fixtures.push(fixture);
    const client = createClient(fixture, { sessionLoadTimeoutMs: 1_000 });

    // The mock answers initialize but never answers session/load.
    const resumePromise = client.resumeSession(
      { provider: "claude-acp", sessionId: "mock-session-1" },
      { cwd: fixture.workdir },
    );
    resumePromise.catch(() => {});

    let pendingPid = 0;
    await waitForCondition(async () => {
      const records = await fixture.registry.list();
      expect(records).toHaveLength(1);
      pendingPid = records[0]?.pid ?? 0;
    });
    expect(pidIsAlive(pendingPid)).toBe(true);

    const startedAt = Date.now();
    await expect(resumePromise).rejects.toThrow("acp_attach_timeout");
    expect(Date.now() - startedAt).toBeLessThan(15_000);

    await waitForCondition(() => {
      expect(pidIsAlive(pendingPid)).toBe(false);
    });
    expect(await fixture.registry.list()).toHaveLength(0);
  }, 60_000);
});
