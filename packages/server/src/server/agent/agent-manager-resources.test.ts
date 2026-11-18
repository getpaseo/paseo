import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { buildConfigOverrides } from "../persistence-hooks.js";
import { AgentManager } from "./agent-manager.js";
import { toAgentPayload } from "./agent-projections.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";
import { AgentStorage } from "./agent-storage.js";
import {
  createFakeResourceHost,
  type FakeResourceHost,
  type FakeResourceHostOptions,
} from "./resources/fake-host.js";
import { AgentResources } from "./resources/index.js";
import {
  InvalidAgentResourcePolicyError,
  UnenforceableAgentResourcePolicyError,
} from "./resources/policy.js";

const logger = createTestLogger();

const CAPABILITIES = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

class IdleSession implements AgentSession {
  readonly provider = "codex";
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();
  constructor(private readonly config: AgentSessionConfig) {}
  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }
  async startTurn(): Promise<{ turnId: string }> {
    return { turnId: randomUUID() };
  }
  subscribe(_callback: (event: AgentStreamEvent) => void): () => void {
    return () => {};
  }
  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}
  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: this.config.model ?? null };
  }
  async getAvailableModes() {
    return [];
  }
  async getCurrentMode() {
    return null;
  }
  async setMode(): Promise<void> {}
  getPendingPermissions() {
    return [];
  }
  async respondToPermission(): Promise<void> {}
  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
}

/** Records the launch context each open hands the provider. */
class LaunchRecordingClient implements AgentClient {
  readonly provider = "codex";
  readonly capabilities = CAPABILITIES;
  readonly launches: Array<AgentLaunchContext | undefined> = [];
  constructor(readonly sharesProcessAcrossAgents = false) {}
  async isAvailable() {
    return true;
  }
  async fetchCatalog() {
    return { models: [], modes: [] };
  }
  async createSession(config: AgentSessionConfig, launchContext?: AgentLaunchContext) {
    this.launches.push(launchContext);
    return new IdleSession(config);
  }
  async resumeSession(
    _handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ) {
    this.launches.push(launchContext);
    return new IdleSession({ provider: this.provider, cwd: config?.cwd ?? process.cwd() });
  }
}

interface Harness {
  manager: AgentManager;
  client: LaunchRecordingClient;
  host: FakeResourceHost;
  resources: AgentResources;
  storage: AgentStorage;
  workdir: string;
}

const workdirs: string[] = [];

afterEach(() => {
  for (const workdir of workdirs.splice(0)) {
    rmSync(workdir, { recursive: true, force: true });
  }
});

async function createHarness(options?: {
  sharesProcessAcrossAgents?: boolean;
  host?: FakeResourceHostOptions;
}): Promise<Harness> {
  const workdir = mkdtempSync(join(tmpdir(), "agent-resources-"));
  workdirs.push(workdir);
  const host = createFakeResourceHost(options?.host);
  const resources = new AgentResources({ logger, namespace: workdir, host });
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  await storage.initialize();
  const client = new LaunchRecordingClient(options?.sharesProcessAcrossAgents);
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    resources,
    logger,
  });
  return { manager, client, host, resources, storage, workdir };
}

function unitCalls(host: FakeResourceHost, verb: string): string[][] {
  return host.commands.filter((command) => command.includes(verb));
}

describe("agent resource policies", () => {
  test("an agent without a policy launches exactly as before", async () => {
    const { manager, client, host, workdir } = await createHarness();

    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });

    const target = { command: "codex", args: ["app-server"], env: {} };
    expect(client.launches[0]?.resources?.wrap(target)).toEqual(target);
    expect(unitCalls(host, "StartTransientUnit")).toEqual([]);
    expect(toAgentPayload(agent).resources).toBeUndefined();
  });

  test("a created agent's provider starts inside the agent's slice, which goes when the agent closes", async () => {
    const { manager, client, host, resources, storage, workdir } = await createHarness();
    const policy = { nice: 5, cpuQuotaPercent: 200, memoryMaxMb: 4096 };

    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, resources: policy },
      undefined,
      { workspaceId: undefined },
    );
    await manager.flush();

    const slice = resources.sliceFor(agent.id);
    const wrapped = client.launches[0]?.resources?.wrap({
      command: "codex",
      args: ["app-server"],
      env: {},
    });
    expect(wrapped?.args).toContain(`--slice=${slice}`);
    expect(toAgentPayload(agent).resources).toEqual(policy);
    expect((await storage.get(agent.id))?.config?.resources).toEqual(policy);

    await manager.closeAgent(agent.id);

    // Once before the slice is created, once to remove it.
    const stop = ["/usr/bin/systemctl", "--user", "stop", slice];
    expect(unitCalls(host, "stop")).toEqual([stop, stop]);
  });

  test("a policy whose memory threshold exceeds its hard limit is refused before anything starts", async () => {
    const { manager, client, workdir } = await createHarness();

    await expect(
      manager.createAgent(
        { provider: "codex", cwd: workdir, resources: { memoryHighMb: 4096, memoryMaxMb: 1024 } },
        undefined,
        { workspaceId: undefined },
      ),
    ).rejects.toBeInstanceOf(InvalidAgentResourcePolicyError);
    expect(client.launches).toEqual([]);
  });

  test("changing a running agent's policy updates its slice in place and is stored", async () => {
    const { manager, client, host, resources, storage, workdir } = await createHarness();
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, resources: { memoryMaxMb: 4096 } },
      undefined,
      { workspaceId: undefined },
    );

    await manager.setAgentResources(agent.id, { cpuQuotaPercent: 50, memoryMaxMb: 2048 });

    expect(unitCalls(host, "SetUnitProperties").at(-1)).toEqual(
      expect.arrayContaining([
        resources.sliceFor(agent.id),
        "CPUQuotaPerSecUSec",
        "500000",
        "MemoryMax",
        String(2048 * 1024 * 1024),
        // Controls the policy no longer sets are lifted, not left behind.
        "MemoryHigh",
        "18446744073709551615",
      ]),
    );
    expect(client.launches).toHaveLength(1);
    expect(toAgentPayload(manager.getAgent(agent.id)!).resources).toEqual({
      cpuQuotaPercent: 50,
      memoryMaxMb: 2048,
    });
    expect((await storage.get(agent.id))?.config?.resources).toEqual({
      cpuQuotaPercent: 50,
      memoryMaxMb: 2048,
    });
  });

  test("a policy set on a closed agent is stored and applies when it resumes", async () => {
    const { manager, client, resources, storage, workdir } = await createHarness();
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    await manager.closeAgent(agent.id);
    const record = await storage.get(agent.id);
    // A loader reads the record and builds its overrides before entering the agent's
    // lane; the policy change queued ahead of the resume is not in them.
    const staleOverrides = buildConfigOverrides(record!);

    const update = manager.setAgentResources(agent.id, { nice: 19, memoryMaxMb: 1024 });
    const resume = manager.resumeAgentFromPersistence(
      record!.persistence!,
      staleOverrides,
      agent.id,
    );
    await Promise.all([update, resume]);

    const launch = client.launches.at(-1)?.resources?.wrap({
      command: "codex",
      args: ["app-server"],
      env: {},
    });
    expect(launch?.args).toContain(`--slice=${resources.sliceFor(agent.id)}`);
    expect(manager.getAgent(agent.id)?.config.resources).toEqual({ nice: 19, memoryMaxMb: 1024 });
    expect((await storage.get(agent.id))?.config?.resources).toEqual({
      nice: 19,
      memoryMaxMb: 1024,
    });
  });

  test("a closed agent reports its stored policy as pending", async () => {
    const { manager, workdir } = await createHarness();
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    await manager.closeAgent(agent.id);

    await manager.setAgentResources(agent.id, { nice: 19 });

    expect(await manager.describeAgentResources(agent.id)).toEqual({
      resources: { nice: 19 },
      status: {
        backend: "systemd",
        active: false,
        unit: null,
        cgroup: null,
        controls: {
          nice: {
            state: "pending",
            message: "No agent process is running; this applies when one starts",
          },
        },
      },
    });
  });

  test("clearing the policy removes it from the agent", async () => {
    const { manager, storage, workdir } = await createHarness();
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, resources: { nice: 10 } },
      undefined,
      { workspaceId: undefined },
    );

    await manager.setAgentResources(agent.id, null);

    expect(manager.getAgent(agent.id)?.config.resources).toBeUndefined();
    expect((await storage.get(agent.id))?.config?.resources ?? null).toBeNull();
  });

  test("a policy for a provider that shares one process across agents is refused and nothing starts", async () => {
    const { manager, client, host, workdir } = await createHarness({
      sharesProcessAcrossAgents: true,
    });

    await expect(
      manager.createAgent(
        { provider: "codex", cwd: workdir, resources: { memoryMaxMb: 1024 } },
        undefined,
        { workspaceId: undefined },
      ),
    ).rejects.toThrow(
      "Cannot enforce the resource policy. memoryMaxMb: This provider serves several agents from one process, so a per-agent limit cannot be applied",
    );
    expect(client.launches).toEqual([]);
    expect(unitCalls(host, "StartTransientUnit")).toEqual([]);

    const unbounded = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    await expect(manager.setAgentResources(unbounded.id, { nice: 5 })).rejects.toBeInstanceOf(
      UnenforceableAgentResourcePolicyError,
    );
    expect(manager.getAgent(unbounded.id)?.config.resources).toBeUndefined();
  });

  test("a control the host cannot enforce is refused for running and stored agents, and nothing is stored", async () => {
    const { manager, storage, workdir } = await createHarness({
      host: { controllers: "memory pids" },
    });
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, resources: { memoryMaxMb: 1024 } },
      undefined,
      { workspaceId: undefined },
    );
    const refused =
      "Cannot enforce the resource policy. cpuWeight: The cpu cgroup controller is not delegated to the systemd user manager";

    await expect(manager.setAgentResources(agent.id, { cpuWeight: 10 })).rejects.toThrow(refused);
    await manager.closeAgent(agent.id);
    await expect(manager.setAgentResources(agent.id, { cpuWeight: 10 })).rejects.toThrow(refused);

    expect((await storage.get(agent.id))?.config?.resources).toEqual({ memoryMaxMb: 1024 });
  });

  test("a daemon without resource controls refuses every policy and advertises none", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-resources-"));
    workdirs.push(workdir);
    const client = new LaunchRecordingClient();
    const manager = new AgentManager({ clients: { codex: client }, logger });

    expect(manager.supportsResourcePolicies).toBe(false);
    await expect(
      manager.createAgent({ provider: "codex", cwd: workdir, resources: { nice: 5 } }, undefined, {
        workspaceId: undefined,
      }),
    ).rejects.toThrow(
      "Cannot enforce the resource policy. nice: This daemon runs without resource controls",
    );
    expect(client.launches).toEqual([]);
  });

  test("advertises resource controls only on a host that can enforce one", async () => {
    expect((await createHarness()).manager.supportsResourcePolicies).toBe(true);
    expect(
      (await createHarness({ host: { platform: "darwin" } })).manager.supportsResourcePolicies,
    ).toBe(false);
  });
});
