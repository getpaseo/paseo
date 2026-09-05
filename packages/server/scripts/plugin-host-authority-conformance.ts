import { createServer } from "node:http";
import { fork } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentManager } from "../src/server/agent/agent-manager.ts";
import { AgentStorage } from "../src/server/agent/agent-storage.ts";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
} from "../src/server/workspace-registry.ts";
import { DeliveryLedger } from "../src/server/deliveries/delivery-ledger.ts";
import { DownloadTokenStore } from "../src/server/file-download/token-store.ts";
import { PluginRuntime } from "../src/server/plugins/runtime.ts";
import { VoiceAssistantWebSocketServer } from "../src/server/websocket-server.ts";

declare const __PASEO_PLUGIN_PROCESS_SOURCE__: string;
declare const __PASEO_SOURCE_COMMIT__: string;

const PASEO_SOURCE_COMMIT = __PASEO_SOURCE_COMMIT__;
const PLUGIN_ID = "authority-conformance";
const CALLER_AGENT_ID = "00000000-0000-4000-8000-000000000001";
const CHILD_AGENT_ID = "00000000-0000-4000-8000-000000000002";
const REPLACEMENT_CHILD_AGENT_ID = "00000000-0000-4000-8000-000000000003";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000011";
const PROJECT_ID = "00000000-0000-4000-8000-000000000021";
const DELIVERY_ID = "authority-conformance-delivery";
const SECOND_DELIVERY_ID = "authority-conformance-second-delivery";
const TIMESTAMP = "2026-09-05T00:00:00.000Z";
const CASE_IDS = [
  "compiler.target-bounded-bundles",
  "runtime.compiles-loads-and-publishes-tool",
  "host.delivery.targets-live-caller-and-is-idempotent",
  "host.child.create-inherits-live-caller-authority-after-mutation",
  "host.unauthorized-or-stale-selector-rejected",
  "delivery.reconnects-stable-installation-and-tombstones",
  "installation.replacement-fences-stale-generation-and-nonce",
];

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function equal<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function projectRecord(root: string) {
  return {
    projectId: PROJECT_ID,
    rootPath: root,
    kind: "git" as const,
    displayName: "Conformance project",
    projectKey: "conformance-project",
    customName: null,
    customIconRevision: null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    archivedAt: null,
  };
}

function workspaceRecord(root: string) {
  return {
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    cwd: root,
    kind: "local_checkout" as const,
    displayName: "Conformance workspace",
    title: null,
    branch: null,
    worktreeRoot: null,
    baseBranch: null,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    archivedAt: null,
    autoArchivedChangeRequestUrl: null,
    pinnedAt: null,
    labels: [],
  };
}

function fakeProviderSession(provider: string, config: Record<string, unknown>) {
  const modes = [{ id: "default", label: "Default", isUnattended: false }];
  return {
    provider,
    id: "in-memory-provider-session",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    async run() {
      return { status: "idle" };
    },
    async startTurn() {
      return { turnId: "in-memory-turn" };
    },
    subscribe() {
      return () => {};
    },
    async *streamHistory() {},
    async getRuntimeInfo() {
      return {
        provider,
        sessionId: "in-memory-provider-session",
        model: typeof config.model === "string" ? config.model : null,
        thinkingOptionId:
          typeof config.thinkingOptionId === "string" ? config.thinkingOptionId : null,
        modeId: "default",
      };
    },
    async getAvailableModes() {
      return modes;
    },
    async getCurrentMode() {
      return "default";
    },
    async setMode() {},
    getPendingPermissions() {
      return [];
    },
    async respondToPermission() {},
    describePersistence() {
      return { provider, sessionId: "in-memory-provider-session", metadata: config };
    },
    async interrupt() {},
    async close() {},
  };
}

function fakeProviderClient(provider: string) {
  const capabilities = {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: false,
    supportsMcpServers: false,
    supportsReasoningStream: false,
    supportsToolInvocations: false,
  };
  return {
    provider,
    capabilities,
    async isAvailable() {
      return true;
    },
    async createSession(config: Record<string, unknown>) {
      return fakeProviderSession(provider, config);
    },
    async resumeSession(_handle: unknown, config: Record<string, unknown>) {
      return fakeProviderSession(provider, config);
    },
    async fetchCatalog() {
      return {
        models: [{ id: "parent-model", label: "Parent", provider, isDefault: true }],
        modes: [{ id: "default", label: "Default" }],
      };
    },
  };
}

function createPluginSource(): string {
  return `import { z } from "zod";
import { defineTool } from "@getpaseo/plugin/server";

const tool = defineTool({
  name: "conformance.host_authority",
  title: "Host authority conformance",
  description: "Exercise the invocation-scoped host authority contract.",
  input: z.object({ mode: z.enum(["delivery", "child"]), delayMs: z.number().int().nonnegative().optional() }),
  async handler(input, context) {
    await new Promise((resolve) => setTimeout(resolve, input.delayMs ?? 20));
    if (input.mode === "delivery") {
      const first = await context.host.deliveries.send({ kind: "conformance" }, { deliveryId: "${DELIVERY_ID}", messageId: "authority-conformance-message" });
      const second = await context.host.deliveries.send({ kind: "conformance" }, { deliveryId: "${DELIVERY_ID}", messageId: "authority-conformance-message" });
      const acknowledged = await context.host.deliveries.acknowledge("${DELIVERY_ID}");
      const fetched = await context.host.deliveries.get({ deliveryId: "${DELIVERY_ID}", includeAcknowledged: true });
      await context.host.deliveries.send({ kind: "second" }, { deliveryId: "${SECOND_DELIVERY_ID}", messageId: "authority-conformance-second-message" });
      const secondAck = await context.host.deliveries.acknowledge("${SECOND_DELIVERY_ID}");
      await new Promise((resolve) => setTimeout(resolve, input.delayMs ?? 20));
      const tombstone = await context.host.deliveries.get({ deliveryId: "${SECOND_DELIVERY_ID}", includeAcknowledged: true });
      return { callerAgentId: context.caller.callerAgentId, callerCwd: context.caller.agent.cwd, targetAgentId: first.targetAgentId, deliveryId: first.deliveryId, firstStatus: first.status, secondStatus: second.status, acknowledgedStatus: acknowledged.status, fetchedStatus: fetched.delivery?.status ?? null, retrySequence: first.sequence === second.sequence, secondAckStatus: secondAck.status, tombstonePayloadPresent: tombstone.delivery?.payload !== undefined };
    }
    const child = await context.host.children.create({ title: "Conformance child" });
    return { callerAgentId: context.caller.callerAgentId, callerCwd: context.caller.agent.cwd, childAgentId: child.agentId, childParentAgentId: child.parentAgentId, childCwd: child.cwd, childProvider: child.provider, childModel: child.model, childThinking: child.thinking };
  },
});

export default function contribute(plugin) {
  plugin.addTool(tool);
  return () => undefined;
}
`;
}

function providerSnapshotStub() {
  return {
    on: () => providerSnapshotStub(),
    off: () => providerSnapshotStub(),
    destroy: () => {},
    resolveCreateConfig: async (input: { requestedMode?: string }) => ({
      modeId: input.requestedMode ?? "default",
      featureValues: undefined,
    }),
    getSnapshot: () => [],
    listProviderAvailability: () => [],
    listDraftFeatures: async () => [],
    listProviders: async () => [],
  };
}

function daemonConfigStub() {
  return {
    get: () => ({ mcp: { injectIntoAgents: false }, providers: {}, plugins: { enabled: true } }),
    onChange: () => () => {},
    onApply: () => () => {},
    reload: async () => {},
  };
}

function workspaceGitStub() {
  return {
    registerWorkspace: () => ({ unsubscribe: () => {} }),
    onSnapshotUpdated: () => ({ unsubscribe: () => {} }),
    peekSnapshot: () => null,
    getCheckout: async (cwd: string) => ({
      cwd,
      isGit: false,
      currentBranch: null,
      remoteUrl: null,
      worktreeRoot: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    }),
    getSnapshot: async () => null,
    resolveForge: async () => null,
    getCheckoutDiff: async () => ({ diff: "" }),
    validateBranchRef: async () => ({ kind: "not-found" }),
    hasLocalBranch: async () => false,
    suggestBranchesForCwd: async () => [],
    listStashes: async () => [],
    listWorktrees: async () => [],
    getProjectSlug: async () => "conformance",
    resolveRepoRoot: async (cwd: string) => cwd,
    resolveDefaultBranch: async () => "main",
    resolveRepoRemoteUrl: async () => null,
    refresh: async () => {},
    requestWorkingTreeWatch: async () => ({ repoRoot: null, unsubscribe: () => {} }),
    scheduleRefreshForCwd: () => {},
    onWorkspaceStateMayHaveChanged: () => {},
    invalidateForge: () => {},
    getMetrics: () => ({ fileObserver: {} }),
    dispose: async () => {},
  };
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-plugin-host-conformance-"));
  const home = path.join(root, "home");
  const movedCwd = path.join(root, "moved");
  await mkdir(path.join(home, "agents"), { recursive: true });
  await mkdir(movedCwd, { recursive: true });
  const logger = new Proxy(
    { level: "silent" },
    {
      get(target, property) {
        if (property in target) return target[property as keyof typeof target];
        if (property === "child") return () => logger;
        return () => {};
      },
    },
  ) as never;
  const projectRegistry = new FileBackedProjectRegistry(path.join(home, "projects.json"), logger, {
    projectIdFactory: () => PROJECT_ID,
  });
  const workspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(home, "workspaces.json"),
    logger,
  );
  await projectRegistry.initialize();
  await workspaceRegistry.initialize();
  await projectRegistry.upsert(projectRecord(root));
  await workspaceRegistry.upsert(workspaceRecord(root));
  const agentStorage = new AgentStorage(path.join(home, "agents"), logger);
  await agentStorage.initialize();
  let nextId = 1;
  const fakeClient = fakeProviderClient("codex");
  const updatedFakeClient = fakeProviderClient("codex-updated");
  const agentManager = new AgentManager({
    logger,
    idFactory: () =>
      [CALLER_AGENT_ID, CHILD_AGENT_ID, REPLACEMENT_CHILD_AGENT_ID][nextId++] ??
      `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`,
    registry: agentStorage,
    clients: { codex: fakeClient, "codex-updated": updatedFakeClient },
    providerDefinitions: {
      codex: {
        enabled: true,
        validateOptions: (options: unknown) => options,
        applyOptions: (config: Record<string, unknown>, options: unknown) => ({
          ...config,
          providerOptions: options,
        }),
        applyToolPolicy: (config: Record<string, unknown>, toolPolicy: unknown) => ({
          ...config,
          toolPolicy,
        }),
      },
      "codex-updated": {
        enabled: true,
        validateOptions: (options: unknown) => options,
        applyOptions: (config: Record<string, unknown>, options: unknown) => ({
          ...config,
          providerOptions: options,
        }),
        applyToolPolicy: (config: Record<string, unknown>, toolPolicy: unknown) => ({
          ...config,
          toolPolicy,
        }),
      },
    },
  });
  const parent = await agentManager.createAgent(
    {
      provider: "codex",
      cwd: root,
      model: "parent-model",
      thinkingOptionId: "parent-thinking",
      modeId: "default",
      providerOptions: { marker: "parent" },
      toolPolicy: { preapproved: [] },
    },
    CALLER_AGENT_ID,
    { workspaceId: WORKSPACE_ID },
  );
  const ledger = new DeliveryLedger(path.join(home, "deliveries"), {
    acknowledgedPayloadMaxAgeMs: 1,
    maxAcknowledgedPayloads: 1,
  });
  const httpServer = createServer();
  const server = new VoiceAssistantWebSocketServer(
    httpServer,
    logger,
    "plugin-authority-conformance",
    agentManager,
    agentStorage,
    new DownloadTokenStore({ ttlMs: 60_000 }),
    home,
    daemonConfigStub(),
    null,
    { allowedOrigins: new Set() },
    { scheduleForWorktree: () => {}, scheduleForDirectory: () => {} },
    undefined,
    undefined,
    undefined,
    undefined,
    "conformance",
    undefined,
    projectRegistry,
    workspaceRegistry,
    {},
    { scheduleRefreshForCwd: () => {}, dispose: () => {}, getMetrics: () => ({}) },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    workspaceGitStub(),
    undefined,
    undefined,
    providerSnapshotStub(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    ledger,
  );
  const pluginDirectory = path.join(root, "plugin");
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({ id: PLUGIN_ID }),
  );
  await writeFile(path.join(pluginDirectory, "index.ts"), createPluginSource());
  const workerPath = path.join(root, "plugin-process.mjs");
  await writeFile(workerPath, __PASEO_PLUGIN_PROCESS_SOURCE__, "utf8");
  const nodePath = [
    process.env.PASEO_CONFORMANCE_NODE_PATH,
    path.join(process.cwd(), "node_modules"),
    path.join(process.cwd(), "packages/server/node_modules"),
  ]
    .filter((value): value is string => Boolean(value))
    .join(path.delimiter);
  const runtime = new PluginRuntime(logger, "conformance", {
    sessionHost: {
      attachPluginSocket: server.attachPluginSocket.bind(server),
      beginPluginShutdown: server.beginPluginShutdown.bind(server),
      finishPluginShutdown: server.finishPluginShutdown.bind(server),
      invokePluginHost: server.invokePluginHost.bind(server),
    },
    resolveToolContext: async (callerAgentId) => {
      const session = server
        .listSessions()
        .find((candidate) => candidate.getPluginIdentity()?.pluginId === PLUGIN_ID);
      assert(session, "plugin session was not available for tool context resolution");
      return session.resolvePluginToolContext(callerAgentId);
    },
    spawnChild: () =>
      fork(workerPath, [], {
        env: { ...process.env, NODE_PATH: nodePath },
        serialization: "advanced",
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      }),
  });
  let reconnectRuntime: PluginRuntime | null = null;
  const getLiveParent = () => {
    const liveParent = (
      agentManager as unknown as {
        agents: Map<string, import("../src/server/agent/agent-manager.ts").ManagedAgent>;
      }
    ).agents.get(CALLER_AGENT_ID);
    assert(liveParent, "managed caller agent disappeared");
    return liveParent;
  };
  return {
    root,
    movedCwd,
    parent,
    ledger,
    server,
    runtime,
    pluginDirectory,
    getLiveParent,
    async moveParentAuthority() {
      await workspaceRegistry.update(WORKSPACE_ID, (record) => ({
        ...record,
        cwd: movedCwd,
        updatedAt: TIMESTAMP,
      }));
      // The harness mutates the actual managed record; authority resolution still goes through
      // Session and AgentManager production APIs, so the plugin never receives this object.
      const liveParent = getLiveParent();
      liveParent.cwd = movedCwd;
      liveParent.provider = "codex-updated";
      liveParent.config = {
        ...liveParent.config,
        provider: "codex-updated",
        cwd: movedCwd,
        model: "updated-model",
        thinkingOptionId: "updated-thinking",
        providerOptions: { marker: "updated" },
        toolPolicy: { preapproved: [] },
      };
      liveParent.runtimeInfo = {
        provider: "codex-updated",
        sessionId: "updated-provider-session",
        model: "updated-model",
        thinkingOptionId: "updated-thinking",
        modeId: "default",
      };
    },
    async reconnectPlugin(installationId: string) {
      const loaded = (
        runtime as unknown as {
          plugins: Map<
            string,
            {
              installationId: string;
              sessionSocket: { close: () => void };
              sessionClosed: Promise<void>;
            }
          >;
        }
      ).plugins.get(PLUGIN_ID);
      assert(loaded, "plugin installation disappeared before reconnect");
      equal(loaded.installationId, installationId, "reconnect source installation identity");
      loaded.sessionSocket.close();
      await loaded.sessionClosed;
      reconnectRuntime = new PluginRuntime(logger, "conformance", {
        installationIdFactory: () => installationId,
        sessionHost: {
          attachPluginSocket: server.attachPluginSocket.bind(server),
          beginPluginShutdown: server.beginPluginShutdown.bind(server),
          finishPluginShutdown: server.finishPluginShutdown.bind(server),
          invokePluginHost: server.invokePluginHost.bind(server),
        },
        resolveToolContext: async (callerAgentId) => {
          const session = server
            .listSessions()
            .find(
              (candidate) =>
                candidate.getPluginIdentity()?.pluginId === PLUGIN_ID &&
                candidate.getPluginIdentity()?.installationId === installationId,
            );
          assert(session, "reconnected plugin session was not routed through WebSocketServer");
          return session.resolvePluginToolContext(callerAgentId);
        },
        spawnChild: () =>
          fork(workerPath, [], {
            env: { ...process.env, NODE_PATH: nodePath },
            serialization: "advanced",
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          }),
      });
      await reconnectRuntime.startPlugin(PLUGIN_ID, pluginDirectory);
      return reconnectRuntime;
    },
    async close() {
      await reconnectRuntime?.stopAll();
      await runtime.stopAll();
      await server.close();
      httpServer.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function compilerCase() {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-conformance-"));
  try {
    const entryPath = path.join(directory, "index.ts");
    await writeFile(
      entryPath,
      `const tool = { name: "server.tool" };\nconst surface = () => "client";\nexport default function contribute(plugin) {\n  plugin.addTool(tool);\n  plugin.addSurface("main", surface);\n  return () => undefined;\n}\n`,
    );
    const { compilePlugin } = await import("../src/server/plugins/compiler.ts");
    const bundles = await compilePlugin(entryPath);
    const catalogs = { client: [] as unknown[][], server: [] as unknown[][] };
    const evaluate = (bundle: string, target: "client" | "server") => {
      const factory = (0, eval)(bundle) as (require: (specifier: string) => unknown) => {
        default: (context: Record<string, unknown>) => unknown;
      };
      const exports = factory(() => ({}));
      const context = {
        addTool: (value: unknown) => catalogs.server.push(["tool", value]),
        handle: (value: unknown, handler: unknown) => catalogs.server.push(["rpc", value, handler]),
        addSurface: (name: unknown, value: unknown) =>
          catalogs.client.push(["surface", name, value]),
        addSidebarItem: (value: unknown) => catalogs.client.push(["sidebar", value]),
        addWorkspacePanel: (value: unknown) => catalogs.client.push(["panel", value]),
        addCommandCenterItem: (value: unknown) => catalogs.client.push(["command", value]),
        addClientSide: (value: unknown) => catalogs.client.push(["clientSide", value]),
        addAttachmentSource: (value: unknown) => catalogs.client.push(["attachment", value]),
        addTheme: (value: unknown) => catalogs.client.push(["theme", value]),
        addTimelineTransformer: (value: unknown) => catalogs.client.push(["transformer", value]),
        addTimelineRenderer: (value: unknown) => catalogs.client.push(["renderer", value]),
      };
      assert(typeof exports.default === "function", `${target} bundle has no activation function`);
      assert(
        typeof exports.default(context) === "function",
        `${target} activation did not return cleanup`,
      );
    };
    evaluate(bundles.clientBundle, "client");
    evaluate(bundles.serverBundle, "server");
    equal(
      JSON.stringify(catalogs.client.map((catalogEntry) => catalogEntry.slice(0, 2))),
      JSON.stringify([["surface", "main"]]),
      "client registration catalog",
    );
    equal(
      JSON.stringify(catalogs.server.map((catalogEntry) => catalogEntry.slice(0, 2))),
      JSON.stringify([["tool", { name: "server.tool" }]]),
      "server registration catalog",
    );
    for (const [label, source] of [
      [
        "helper",
        `function register(plugin) { plugin.addSurface("escaped", () => undefined); }\nexport default function contribute(plugin) { register(plugin); return () => undefined; }\n`,
      ],
      [
        "computed",
        `export default function contribute(plugin) { plugin["addSurface"]("escaped", () => undefined); return () => undefined; }\n`,
      ],
    ] as const) {
      await writeFile(entryPath, source);
      let rejected = false;
      try {
        await compilePlugin(entryPath);
      } catch {
        rejected = true;
      }
      assert(rejected, `compiler accepted ${label} registration escape`);
    }
    return {
      clientCatalog: catalogs.client.map((catalogEntry) => catalogEntry.slice(0, 2)),
      serverCatalog: catalogs.server.map((catalogEntry) => catalogEntry.slice(0, 2)),
      rejectedHelperAndComputedEscapes: true,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function invokeTool(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  input: Record<string, unknown>,
  callerAgentId = CALLER_AGENT_ID,
  runtime = fixture.runtime,
) {
  return runtime.invokeTool(PLUGIN_ID, "conformance.host_authority", input, {
    callerAgentId,
    timeoutMs: 10_000,
  });
}

function settle<T>(
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

async function installationIdentity(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  runtime = fixture.runtime,
) {
  const loaded = (
    runtime as unknown as {
      plugins: Map<string, { generation: number; installationId: string }>;
    }
  ).plugins.get(PLUGIN_ID);
  assert(loaded, "runtime installation is missing");
  const session = fixture.server
    .listSessions()
    .find(
      (candidate) =>
        candidate.getPluginIdentity()?.pluginId === PLUGIN_ID &&
        candidate.getPluginIdentity()?.installationId === loaded.installationId,
    );
  assert(session, "plugin session was not routed through WebSocketServer");
  const identity = session.getPluginIdentity();
  assert(identity, "plugin installation identity is missing");
  equal(identity.installationId, loaded.installationId, "WebSocket session installation identity");
  return loaded;
}

async function runCase(
  results: Array<Record<string, unknown>>,
  id: string,
  operation: () => Promise<unknown>,
) {
  try {
    results.push({ case: id, ok: true, details: await operation() });
  } catch (error) {
    results.push({ case: id, ok: false, error: errorText(error) });
  }
}

export async function runConformance() {
  const results: Array<Record<string, unknown>> = [];
  await runCase(results, CASE_IDS[0], compilerCase);
  const fixture = await createFixture();
  try {
    await runCase(results, CASE_IDS[1], async () => {
      try {
        await fixture.runtime.startPlugin(PLUGIN_ID, fixture.pluginDirectory);
      } catch (error) {
        throw new Error(
          `${errorText(error)}; plugin logs: ${JSON.stringify(fixture.runtime.getLogs(PLUGIN_ID))}`,
          { cause: error },
        );
      }
      const catalog = fixture.runtime.toolCatalog();
      equal(
        JSON.stringify(catalog.map((entry) => entry.name)),
        JSON.stringify(["conformance.host_authority"]),
        "published tool catalog",
      );
      await installationIdentity(fixture);
      return { catalog: catalog.map((entry) => entry.name), routedByWebSocketServer: true };
    });
    await runCase(results, CASE_IDS[2], async () => {
      const operation = settle(invokeTool(fixture, { mode: "delivery", delayMs: 5 }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const identity = await installationIdentity(fixture);
      await fixture.ledger.gc(`plugin:${PLUGIN_ID}:${identity.installationId}`, true);
      const settled = await operation;
      if (!settled.ok) throw settled.error;
      const result = settled.value as Record<string, unknown>;
      equal(result.targetAgentId, CALLER_AGENT_ID, "delivery target");
      equal(result.deliveryId, DELIVERY_ID, "stable delivery id");
      equal(result.firstStatus, "accepted", "first delivery status");
      equal(result.secondStatus, "accepted", "retry status");
      equal(result.fetchedStatus, "acknowledged", "get status");
      equal(result.acknowledgedStatus, "acknowledged", "ack status");
      equal(result.retrySequence, true, "retry sequence");
      return result;
    });
    await runCase(results, CASE_IDS[3], async () => {
      const operation = settle(invokeTool(fixture, { mode: "child", delayMs: 35 }));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await fixture.moveParentAuthority();
      const settled = await operation;
      if (!settled.ok) throw settled.error;
      const result = settled.value as Record<string, unknown>;
      equal(result.childParentAgentId, CALLER_AGENT_ID, "child parent");
      equal(result.childCwd, fixture.movedCwd, "child cwd inheritance");
      equal(result.childProvider, "codex-updated", "child provider inheritance");
      equal(result.childModel, "updated-model", "child model inheritance");
      equal(result.childThinking, "updated-thinking", "child thinking inheritance");
      return {
        child: result.childAgentId,
        inheritedLiveAuthority: true,
        callerCwdBeforeMutation: result.callerCwd,
      };
    });
    await runCase(results, CASE_IDS[4], async () => {
      let unauthorized = false;
      try {
        await invokeTool(fixture, { mode: "delivery" }, "attacker-agent");
      } catch (error) {
        unauthorized = errorText(error).length > 0;
      }
      assert(unauthorized, "unauthorized caller selector was accepted");
      const liveParent = fixture.getLiveParent();
      const current = liveParent.lifecycle;
      liveParent.lifecycle = "closed";
      let stale = false;
      try {
        await invokeTool(fixture, { mode: "delivery" });
      } catch (error) {
        stale = errorText(error).length > 0;
      } finally {
        liveParent.lifecycle = current;
      }
      assert(stale, "stale caller selector was accepted");
      return { unauthorizedRejected: unauthorized, staleRejected: stale };
    });
    await runCase(results, CASE_IDS[5], async () => {
      const identity = await installationIdentity(fixture);
      const reconnectedRuntime = await fixture.reconnectPlugin(identity.installationId);
      const reconnectedIdentity = await installationIdentity(fixture, reconnectedRuntime);
      equal(
        reconnectedIdentity.installationId,
        identity.installationId,
        "reconnect installation identity",
      );
      const reconnectedResult = (await invokeTool(
        fixture,
        { mode: "delivery", delayMs: 1 },
        CALLER_AGENT_ID,
        reconnectedRuntime,
      )) as Record<string, unknown>;
      equal(reconnectedResult.targetAgentId, CALLER_AGENT_ID, "reconnected delivery target");
      const principal = `plugin:${PLUGIN_ID}:${identity.installationId}`;
      const before = await fixture.ledger.get(principal, {
        deliveryId: SECOND_DELIVERY_ID,
        includeAcknowledged: true,
        allowPayloadTombstones: true,
      });
      equal(before.delivery?.status, "acknowledged", "tombstone source status");
      assert(
        before.delivery?.payload === undefined,
        "acknowledged delivery was not compacted to a tombstone",
      );
      return {
        installationId: identity.installationId,
        reconnectInstallationId: reconnectedIdentity.installationId,
        stablePrincipal: principal,
        reconnectedTargetAgentId: reconnectedResult.targetAgentId,
        tombstoned: true,
      };
    });
    await runCase(results, CASE_IDS[6], async () => {
      const first = await installationIdentity(fixture);
      await fixture.runtime.stopPluginById(PLUGIN_ID);
      let staleInstallRejected = false;
      try {
        await fixture.server.invokePluginHost({
          pluginId: PLUGIN_ID,
          caller: {} as never,
          invocationId: "stale",
          generation: first.generation,
          installationId: first.installationId,
          capabilityNonce: "stale-nonce",
          operation: "delivery.get",
          input: {},
          signal: new AbortController().signal,
        });
      } catch (error) {
        staleInstallRejected = errorText(error).length > 0;
      }
      assert(staleInstallRejected, "stale installation host work was accepted");
      await fixture.runtime.startPlugin(PLUGIN_ID, fixture.pluginDirectory);
      const replacement = await installationIdentity(fixture);
      assert(replacement.generation > first.generation, "replacement did not advance generation");
      assert(
        replacement.installationId !== first.installationId,
        "replacement reused installation id",
      );
      let staleGenerationRejected = false;
      try {
        await fixture.runtime.invokeTool(
          PLUGIN_ID,
          "conformance.host_authority",
          { mode: "delivery" },
          {
            callerAgentId: CALLER_AGENT_ID,
            generation: first.generation,
            installationId: first.installationId,
          },
        );
      } catch (error) {
        staleGenerationRejected = errorText(error).length > 0;
      }
      assert(staleGenerationRejected, "stale generation work was accepted");
      return {
        oldGeneration: first.generation,
        newGeneration: replacement.generation,
        staleNonceRejected: staleInstallRejected,
        staleGenerationRejected,
      };
    });
  } finally {
    await fixture.close();
  }
  return results;
}

if (process.argv.includes("--json")) {
  try {
    const cases = await runConformance();
    process.stdout.write(
      `${JSON.stringify({ sourceCommit: PASEO_SOURCE_COMMIT, caseIds: CASE_IDS, cases })}\n`,
    );
    if (cases.some((result) => result.ok !== true)) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ sourceCommit: PASEO_SOURCE_COMMIT, caseIds: CASE_IDS, cases: [{ case: "harness", ok: false, error: errorText(error) }] })}\n`,
    );
    process.exitCode = 1;
  }
} else {
  try {
    const cases = await runConformance();
    for (const result of cases) process.stdout.write(`${JSON.stringify(result)}\n`);
    if (cases.some((result) => result.ok !== true)) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ case: "harness", ok: false, error: errorText(error) })}\n`,
    );
    process.exitCode = 1;
  }
}
