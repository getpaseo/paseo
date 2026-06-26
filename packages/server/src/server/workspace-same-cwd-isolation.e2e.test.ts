import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DaemonClient } from "./test-utils/index.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { getAskModeConfig } from "./daemon-e2e/agent-configs.js";
import { MockLoadTestAgentClient } from "./agent/providers/mock-load-test-agent.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
} from "./agent/agent-sdk-types.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";

const WORKSPACE_A = "wks_same_cwd_a";
const WORKSPACE_B = "wks_same_cwd_b";
const LEGACY_OWNER_WORKSPACE = "wks_legacy_owner";
const PERMISSION_WAIT_MS = 15_000;
const SNAPSHOT_STORM_PROVIDER_COUNT = 18;
const SNAPSHOT_STORM_MODELS_PER_PROVIDER = 150;
const SNAPSHOT_STORM_DESCRIPTION = "x".repeat(120);

const SNAPSHOT_STORM_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

class SnapshotStormProviderClient implements AgentClient {
  readonly capabilities = SNAPSHOT_STORM_CAPABILITIES;
  private readonly models: AgentModelDefinition[];

  constructor(
    readonly provider: string,
    private readonly delayMs: number,
  ) {
    this.models = Array.from({ length: SNAPSHOT_STORM_MODELS_PER_PROVIDER }, (_, index) => ({
      provider,
      id: `${provider}-model-${index.toString().padStart(3, "0")}`,
      label: `${provider} model ${index.toString().padStart(3, "0")}`,
      description: SNAPSHOT_STORM_DESCRIPTION,
      isDefault: index === 0,
      metadata: {
        providerId: provider,
        modelId: `model-${index.toString().padStart(3, "0")}`,
      },
    }));
  }

  async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
    throw new Error(`${this.provider} is only used for provider snapshot tests`);
  }

  async resumeSession(_handle: AgentPersistenceHandle): Promise<AgentSession> {
    throw new Error(`${this.provider} is only used for provider snapshot tests`);
  }

  async fetchCatalog(): Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return { models: this.models, modes: [] };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

class MetadataMockLoadTestAgentClient extends MockLoadTestAgentClient {
  override async fetchCatalog(): Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }> {
    return {
      models: [
        {
          provider: "mock",
          id: "gpt-5.4-mini",
          label: "GPT 5.4 Mini",
          isDefault: true,
        },
      ],
      modes: [],
    };
  }
}

function createSnapshotStormClients(): SnapshotStormProviderClient[] {
  return Array.from(
    { length: SNAPSHOT_STORM_PROVIDER_COUNT },
    (_, index) =>
      new SnapshotStormProviderClient(`snapshot-storm-${index.toString().padStart(2, "0")}`, index),
  );
}

async function createSnapshotStormDaemon(clients: SnapshotStormProviderClient[]) {
  return createTestPaseoDaemon({
    mcpEnabled: false,
    isDev: true,
    agentClients: {
      mock: new MetadataMockLoadTestAgentClient(),
      ...Object.fromEntries(clients.map((client) => [client.provider, client])),
    },
    providerOverrides: {
      claude: { enabled: false },
      codex: { enabled: false },
      copilot: { enabled: false },
      opencode: { enabled: false },
      pi: { enabled: false },
      omp: { enabled: false },
      "mock-slow": { enabled: false },
      ...Object.fromEntries(
        clients.map((client) => [
          client.provider,
          {
            extends: "mock",
            label: client.provider,
            enabled: true,
          },
        ]),
      ),
    },
  });
}

function collectProviderSnapshotUpdateBytes(client: DaemonClient): {
  sizes: number[];
  unsubscribe: () => void;
} {
  const sizes: number[] = [];
  const unsubscribe = client.subscribeRawMessages((message) => {
    if (message.type !== "providers_snapshot_update") {
      return;
    }
    sizes.push(JSON.stringify({ type: "session", message }).length);
  });
  return { sizes, unsubscribe };
}

// Seed two active workspaces that share one cwd, so we can prove agent
// ownership and status stay workspaceId-scoped — a sibling that owns nothing
// active stays done. Both registry files must exist on disk before the daemon starts:
// bootstrapWorkspaceRegistries skips materialization when both files are
// present, leaving these seeded records untouched.
function seedSameCwdWorkspaces(): { paseoHomeRoot: string; cwd: string } {
  const paseoHomeRoot = mkdtempSync(path.join(tmpdir(), "paseo-same-cwd-home-"));
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-same-cwd-dir-"));
  const projectsDir = path.join(paseoHomeRoot, ".paseo", "projects");
  mkdirSync(projectsDir, { recursive: true });

  const project = createPersistedProjectRecord({
    projectId: "prj_same_cwd",
    rootPath: cwd,
    kind: "non_git",
    displayName: path.basename(cwd),
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  });
  const workspaceA = createPersistedWorkspaceRecord({
    workspaceId: WORKSPACE_A,
    projectId: project.projectId,
    cwd,
    kind: "directory",
    displayName: "workspace-a",
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  });
  // Created later so the deterministic-oldest cwd fallback would never pick B:
  // any correct attribution to B must follow the stamped workspaceId.
  const workspaceB = createPersistedWorkspaceRecord({
    workspaceId: WORKSPACE_B,
    projectId: project.projectId,
    cwd,
    kind: "directory",
    displayName: "workspace-b",
    createdAt: "2026-03-02T00:00:00.000Z",
    updatedAt: "2026-03-02T00:00:00.000Z",
  });

  writeFileSync(path.join(projectsDir, "projects.json"), JSON.stringify([project]));
  writeFileSync(
    path.join(projectsDir, "workspaces.json"),
    JSON.stringify([workspaceA, workspaceB]),
  );

  return { paseoHomeRoot, cwd };
}

async function seedWorkspaceWithLegacyAgent(): Promise<{ paseoHomeRoot: string; cwd: string }> {
  const paseoHomeRoot = mkdtempSync(path.join(tmpdir(), "paseo-legacy-agent-home-"));
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-legacy-agent-dir-"));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  const projectsDir = path.join(paseoHome, "projects");
  mkdirSync(projectsDir, { recursive: true });

  const project = createPersistedProjectRecord({
    projectId: "prj_legacy_agent",
    rootPath: cwd,
    kind: "non_git",
    displayName: path.basename(cwd),
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: LEGACY_OWNER_WORKSPACE,
    projectId: project.projectId,
    cwd,
    kind: "directory",
    displayName: "original",
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  });

  writeFileSync(path.join(projectsDir, "projects.json"), JSON.stringify([project]));
  writeFileSync(path.join(projectsDir, "workspaces.json"), JSON.stringify([workspace]));

  const agentStorage = new AgentStorage(path.join(paseoHome, "agents"), createTestLogger());
  await agentStorage.initialize();
  await agentStorage.upsert({
    id: "legacy-cwd-only-agent",
    provider: "codex",
    cwd,
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
    lastActivityAt: "2026-03-01T12:00:00.000Z",
    lastUserMessageAt: null,
    title: "Legacy cwd-only agent",
    labels: {},
    lastStatus: "running",
    lastModeId: null,
    config: null,
    runtimeInfo: { provider: "codex", sessionId: null },
    persistence: null,
    archivedAt: null,
  });

  return { paseoHomeRoot, cwd };
}

async function statusByWorkspaceId(client: DaemonClient): Promise<Map<string, string>> {
  const workspaces = await client.fetchWorkspaces();
  return new Map(workspaces.entries.map((entry) => [entry.id, entry.status]));
}

async function workspaceName(client: DaemonClient, workspaceId: string): Promise<string | null> {
  const workspaces = await client.fetchWorkspaces();
  return workspaces.entries.find((entry) => entry.id === workspaceId)?.name ?? null;
}

async function legacyAgentWorkspaceId(client: DaemonClient): Promise<string | null | undefined> {
  const agents = await client.fetchAgents({ scope: "active" });
  return agents.entries.find((entry) => entry.agent.id === "legacy-cwd-only-agent")?.agent
    .workspaceId;
}

async function agentIdsOwnedByWorkspace(
  client: DaemonClient,
  workspaceId: string,
): Promise<string[]> {
  const agents = await client.fetchAgents({ scope: "active" });
  return agents.entries
    .filter((entry) => entry.agent.workspaceId === workspaceId)
    .map((entry) => entry.agent.id);
}

async function waitForPermission(client: DaemonClient, agentId: string) {
  const parked = await client.waitForFinish(agentId, PERMISSION_WAIT_MS);
  expect(parked.status).toBe("permission");
  return parked;
}

test("daemon bootstrap migrates cwd-only legacy agents before same-cwd workspaces are added", async () => {
  const { paseoHomeRoot, cwd } = await seedWorkspaceWithLegacyAgent();
  const daemon = await createTestPaseoDaemon({ paseoHomeRoot });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();
    expect(await legacyAgentWorkspaceId(client)).toBe(LEGACY_OWNER_WORKSPACE);
    expect(await statusByWorkspaceId(client)).toEqual(
      new Map([[LEGACY_OWNER_WORKSPACE, "running"]]),
    );

    const created = await client.createWorkspace({
      source: { kind: "directory", path: cwd, projectId: "prj_legacy_agent" },
      title: "Fresh same-cwd workspace",
    });
    const createdWorkspaceId = created.workspace?.id;
    if (!createdWorkspaceId) {
      throw new Error(created.error ?? "Expected same-cwd workspace to be created");
    }

    // The migrated legacy agent stays owned by LEGACY_OWNER. The freshly created
    // same-cwd workspace owns nothing, so its status is done — status is per id,
    // never shared across same-cwd workspaces.
    expect(await legacyAgentWorkspaceId(client)).toBe(LEGACY_OWNER_WORKSPACE);
    expect(await agentIdsOwnedByWorkspace(client, LEGACY_OWNER_WORKSPACE)).toEqual([
      "legacy-cwd-only-agent",
    ]);
    expect(await agentIdsOwnedByWorkspace(client, createdWorkspaceId)).toEqual([]);
    expect(await statusByWorkspaceId(client)).toEqual(
      new Map([
        [LEGACY_OWNER_WORKSPACE, "running"],
        [createdWorkspaceId, "done"],
      ]),
    );
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workspace.create directory source with firstAgentContext generates a daemon-visible workspace title", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-named-local-dir-"));
  const daemon = await createTestPaseoDaemon({
    agentClients: { mock: new MockLoadTestAgentClient() },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();
    await client.patchDaemonConfig({
      metadataGeneration: { providers: [{ provider: "mock", model: "ten-second-stream" }] },
    });

    const created = await client.createWorkspace({
      source: { kind: "directory", path: cwd },
      firstAgentContext: {
        prompt: "Fix login bug",
        attachments: [],
      },
    });
    const workspaceId = created.workspace?.id;
    if (!workspaceId) {
      throw new Error(created.error ?? "Expected workspace to be created");
    }

    await expect
      .poll(() => workspaceName(client, workspaceId), { timeout: 10_000 })
      .toBe("Fix login bug");
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 20_000);

test("local workspace auto-title does not broadcast provider snapshot warm-up to clients", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-title-snapshot-storm-"));
  const stormClients = createSnapshotStormClients();
  const daemon = await createSnapshotStormDaemon(stormClients);
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });
  const snapshotUpdates = collectProviderSnapshotUpdateBytes(client);

  try {
    await client.connect();
    await client.getProvidersSnapshot({ cwd });
    await expect
      .poll(
        async () => {
          const snapshot = await client.getProvidersSnapshot({ cwd });
          return snapshot.entries.filter((entry) => entry.status === "loading").length;
        },
        { timeout: 10_000 },
      )
      .toBe(0);
    snapshotUpdates.sizes.length = 0;

    const created = await client.createWorkspace({
      source: { kind: "directory", path: cwd },
      firstAgentContext: {
        prompt: "hello",
        attachments: [],
      },
    });
    const workspaceId = created.workspace?.id;
    if (!workspaceId) {
      throw new Error(created.error ?? "Expected workspace to be created");
    }

    await expect.poll(() => workspaceName(client, workspaceId), { timeout: 10_000 }).toBe("hello");
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(snapshotUpdates.sizes).toEqual([]);
  } finally {
    snapshotUpdates.unsubscribe();
    await client.close().catch(() => undefined);
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 20_000);

test("create_agent_request with initialPrompt generates a daemon-visible workspace title", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-agent-submit-title-"));
  const daemon = await createTestPaseoDaemon({
    agentClients: { mock: new MockLoadTestAgentClient() },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();
    await client.patchDaemonConfig({
      metadataGeneration: { providers: [{ provider: "mock", model: "ten-second-stream" }] },
    });

    const created = await client.createWorkspace({
      source: { kind: "directory", path: cwd },
    });
    const workspaceId = created.workspace?.id;
    if (!workspaceId) {
      throw new Error(created.error ?? "Expected workspace to be created");
    }

    const agent = await client.createAgent({
      provider: "mock",
      cwd,
      workspaceId,
      model: "ten-second-stream",
      initialPrompt: "Fix login bug",
    });
    expect(agent.workspaceId).toBe(workspaceId);

    await expect
      .poll(() => workspaceName(client, workspaceId), { timeout: 10_000 })
      .toBe("Fix login bug");
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 20_000);

test("creating another same-cwd local workspace keeps running status on the owning workspace only", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-running-same-cwd-create-"));
  const daemon = await createTestPaseoDaemon({
    agentClients: { mock: new MockLoadTestAgentClient() },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();

    const first = await client.createWorkspace({
      source: { kind: "directory", path: cwd },
      title: "First same-cwd workspace",
    });
    const firstWorkspaceId = first.workspace?.id;
    if (!firstWorkspaceId) {
      throw new Error(first.error ?? "Expected first workspace to be created");
    }

    const second = await client.createWorkspace({
      source: { kind: "directory", path: cwd },
      title: "Second same-cwd workspace",
    });
    const secondWorkspaceId = second.workspace?.id;
    if (!secondWorkspaceId) {
      throw new Error(second.error ?? "Expected second workspace to be created");
    }

    const agent = await client.createAgent({
      provider: "mock",
      cwd,
      workspaceId: firstWorkspaceId,
      model: "five-minute-stream",
      initialPrompt: "stay running",
    });
    expect(agent.workspaceId).toBe(firstWorkspaceId);

    await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "running", 15_000);

    // Only the workspace that owns the agent is running. The same-cwd sibling
    // owns nothing active and stays done — status never fans out across a cwd.
    expect(await statusByWorkspaceId(client)).toEqual(
      new Map([
        [firstWorkspaceId, "running"],
        [secondWorkspaceId, "done"],
      ]),
    );

    const third = await client.createWorkspace({
      source: { kind: "directory", path: cwd },
      title: "Third same-cwd workspace",
    });
    const thirdWorkspaceId = third.workspace?.id;
    if (!thirdWorkspaceId) {
      throw new Error(third.error ?? "Expected third workspace to be created");
    }

    expect((await client.fetchAgent(agent.id))?.agent.status).toBe("running");
    expect(await statusByWorkspaceId(client)).toEqual(
      new Map([
        [firstWorkspaceId, "running"],
        [secondWorkspaceId, "done"],
        [thirdWorkspaceId, "done"],
      ]),
    );
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);

test("two workspaces sharing one cwd compute agent status per workspaceId", async () => {
  const { paseoHomeRoot, cwd } = seedSameCwdWorkspaces();
  const daemon = await createTestPaseoDaemon({ paseoHomeRoot });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();

    // Both seeded workspaces are visible and start with no contributing agents.
    expect(await statusByWorkspaceId(client)).toEqual(
      new Map([
        [WORKSPACE_A, "done"],
        [WORKSPACE_B, "done"],
      ]),
    );

    // 1. Agent created in workspace A carries workspaceId A. Ask mode + a
    //    write parks the agent on a pending permission, which drives the
    //    "needs_input" signal onto workspace A only — its same-cwd sibling B
    //    owns nothing and stays done.
    const agentA = await client.createAgent({
      ...getAskModeConfig("codex"),
      cwd,
      workspaceId: WORKSPACE_A,
      title: "Workspace A agent",
    });
    expect(agentA.workspaceId).toBe(WORKSPACE_A);

    await client.sendMessage(
      agentA.id,
      'Use your shell tool to run: `printf "ok" > a.txt`. Request permission and wait.',
    );
    await waitForPermission(client, agentA.id);

    const fetchedA = await client.fetchAgent(agentA.id);
    expect(fetchedA?.agent.workspaceId).toBe(WORKSPACE_A);

    expect(await statusByWorkspaceId(client)).toEqual(
      new Map([
        [WORKSPACE_A, "needs_input"],
        [WORKSPACE_B, "done"],
      ]),
    );

    // 2. Terminal created in A is visible in A's list, but never in B's —
    //    exercises the workspaceId terminal filter at the daemon boundary.
    const createdTerminal = await client.createTerminal(cwd, "A terminal", undefined, {
      workspaceId: WORKSPACE_A,
    });
    expect(createdTerminal.terminal?.workspaceId).toBe(WORKSPACE_A);
    const terminalId = createdTerminal.terminal?.id;
    if (!terminalId) {
      throw new Error("Expected a created terminal id");
    }

    const listForA = await client.listTerminals(cwd, undefined, { workspaceId: WORKSPACE_A });
    expect(listForA.terminals.some((terminal) => terminal.id === terminalId)).toBe(true);

    const listForB = await client.listTerminals(cwd, undefined, { workspaceId: WORKSPACE_B });
    expect(listForB.terminals.some((terminal) => terminal.id === terminalId)).toBe(false);

    // 3. Agent created in workspace B carries workspaceId B and parks too. Now
    //    each workspace owns its own parked agent, so both read needs_input —
    //    by per-id ownership, not by sharing a cwd.
    const agentB = await client.createAgent({
      ...getAskModeConfig("codex"),
      cwd,
      workspaceId: WORKSPACE_B,
      title: "Workspace B agent",
    });
    expect(agentB.workspaceId).toBe(WORKSPACE_B);

    await client.sendMessage(
      agentB.id,
      'Use your shell tool to run: `printf "ok" > b.txt`. Request permission and wait.',
    );
    await waitForPermission(client, agentB.id);

    const fetchedB = await client.fetchAgent(agentB.id);
    expect(fetchedB?.agent.workspaceId).toBe(WORKSPACE_B);

    expect(await statusByWorkspaceId(client)).toEqual(
      new Map([
        [WORKSPACE_A, "needs_input"],
        [WORKSPACE_B, "needs_input"],
      ]),
    );

    await client.killTerminal(terminalId);
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 180000);
