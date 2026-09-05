import { createHash } from "node:crypto";
import { execFileSync, fork } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
declare const __PASEO_SOURCE_MANIFEST__: {
  formatVersion: 1;
  sourceCommit: string;
  sourceInputs: Record<string, string>;
};

const SOURCE_MANIFEST = __PASEO_SOURCE_MANIFEST__;
const PASEO_SOURCE_COMMIT = SOURCE_MANIFEST.sourceCommit;
const PLUGIN_ID = "authority-conformance";
const CALLER_AGENT_ID = "00000000-0000-4000-8000-000000000001";
const ATTACKER_AGENT_ID = "00000000-0000-4000-8000-000000000002";
const CHILD_AGENT_ID = "00000000-0000-4000-8000-000000000003";
const REPLACEMENT_CHILD_AGENT_ID = "00000000-0000-4000-8000-000000000004";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000011";
const PROJECT_ID = "00000000-0000-4000-8000-000000000021";
const DELIVERY_ID = "authority-conformance-delivery";
const SECOND_DELIVERY_ID = "authority-conformance-second-delivery";
const STALE_DELIVERY_ID = "authority-conformance-stale-delivery";
const TIMESTAMP = "2026-09-05T00:00:00.000Z";
const CASE_IDS = [
  "compiler.target-bounded-bundles",
  "runtime.compiles-loads-and-publishes-tool",
  "host.delivery.targets-live-caller-and-is-idempotent",
  "host.worktree.create-remove-enforces-ownership-and-persists",
  "host.child.create-inherits-live-caller-authority-after-mutation",
  "host.unauthorized-or-stale-selector-rejected",
  "delivery.reconnects-stable-installation-and-tombstones",
  "installation.replacement-fences-stale-generation-and-nonce-through-session",
];

function sourceManifestError(message: string): never {
  throw new Error(`Source verification failed: ${message}`);
}

function normalizeManifestPath(relative: string): string {
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative.split("/").some((part) => part === "" || part === "." || part === "..") ||
    relative.includes("\\")
  ) {
    sourceManifestError(`invalid source input path ${JSON.stringify(relative)}`);
  }
  return relative;
}

function isIgnoredSource(root: string, relative: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "--quiet", "--no-index", "--", relative], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function verifySource(root: string): Promise<void> {
  if (SOURCE_MANIFEST.formatVersion !== 1) {
    sourceManifestError(`unsupported manifest version ${SOURCE_MANIFEST.formatVersion}`);
  }
  const sourceRoot = path.resolve(root);
  const tracked = new Set(
    execFileSync("git", ["ls-files", "-z"], { cwd: sourceRoot, encoding: "utf8" })
      .split("\0")
      .filter(Boolean)
      .map((relative) => relative.split(path.sep).join("/")),
  );
  const trackedSources = new Set(
    [...tracked].filter((relative) => /\.(?:[cm]?js|[cm]?ts|jsx?|tsx?|json)$/u.test(relative)),
  );
  const entries = Object.entries(SOURCE_MANIFEST.sourceInputs);
  if (entries.length === 0) sourceManifestError("sourceInputs is empty");
  const seen = new Set<string>();
  for (const [rawRelative, expectedHash] of entries) {
    const relative = normalizeManifestPath(rawRelative);
    if (seen.has(relative)) sourceManifestError(`duplicate source input ${relative}`);
    seen.add(relative);
    if (!trackedSources.has(relative) && !isIgnoredSource(sourceRoot, relative)) {
      sourceManifestError(`extra or untracked source input ${relative}`);
    }
    const sourcePath = path.resolve(sourceRoot, relative);
    let contents: Buffer;
    try {
      contents = await readFile(sourcePath);
    } catch (error) {
      sourceManifestError(
        `missing source input ${relative}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const actualHash = createHash("sha256").update(contents).digest("hex");
    if (actualHash !== expectedHash) {
      sourceManifestError(
        `${relative} hash mismatch (expected ${expectedHash}, got ${actualHash})`,
      );
    }
  }
  for (const relative of trackedSources) {
    if (!seen.has(relative)) sourceManifestError(`missing source input ${relative}`);
  }
}

function verifySourceArgument(argv: string[]): string | null {
  const index = argv.indexOf("--verify-source");
  if (index === -1) return null;
  const root = argv[index + 1];
  if (!root || root.startsWith("--")) {
    throw new Error("--verify-source requires a repository root");
  }
  return root;
}

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
  input: z.object({ mode: z.enum(["delivery", "child", "worktree.create", "worktree.remove", "stale"]), delayMs: z.number().int().nonnegative().optional(), worktreeId: z.string().optional() }),
  async handler(input, context) {
    if (input.mode === "stale") {
      const result = await context.host.deliveries.send(
        { kind: "stale" },
        { deliveryId: "${STALE_DELIVERY_ID}", messageId: "stale-message" },
      );
      return { staleResult: result.status };
    }
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
    if (input.mode === "child") {
      const child = await context.host.children.create({ title: "Conformance child" });
      return { callerAgentId: context.caller.callerAgentId, callerCwd: context.caller.agent.cwd, childAgentId: child.agentId, childParentAgentId: child.parentAgentId, childCwd: child.cwd, childProvider: child.provider, childModel: child.model, childThinking: child.thinking };
    }
    if (input.mode === "worktree.create") {
      const worktree = await context.host.worktrees.create({ name: "conformance-managed", branch: "conformance-managed" });
      return { worktreeId: worktree.id, worktreeCwd: worktree.cwd, workspaceId: worktree.workspace.id, opaqueId: worktree.id !== worktree.cwd };
    }
    await context.host.worktrees.remove(input.worktreeId ?? "");
    return { removedWorktreeId: input.worktreeId ?? "" };
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

function workspaceGitStub(repoRoot: string) {
  return {
    registerWorkspace: () => ({ unsubscribe: () => {} }),
    onSnapshotUpdated: () => ({ unsubscribe: () => {} }),
    peekSnapshot: () => null,
    getCheckout: async (cwd: string) => ({
      cwd,
      isGit: true,
      currentBranch: "main",
      remoteUrl: null,
      worktreeRoot: cwd === repoRoot ? repoRoot : cwd,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: repoRoot,
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
    resolveRepoRoot: async () => repoRoot,
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
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "conformance@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Conformance"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "conformance\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-m", "conformance fixture"], {
    cwd: root,
    stdio: "ignore",
  });
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
  await agentManager.createAgent(
    {
      provider: "codex",
      cwd: root,
      model: "attacker-model",
      thinkingOptionId: "attacker-thinking",
      modeId: "default",
      providerOptions: { marker: "attacker" },
      toolPolicy: { preapproved: [] },
    },
    ATTACKER_AGENT_ID,
    { workspaceId: WORKSPACE_ID },
  );
  const ledger = new DeliveryLedger(path.join(home, "deliveries"), {
    acknowledgedPayloadMaxAgeMs: 1,
    maxAcknowledgedPayloads: 1,
  });
  const originalLedgerSend = ledger.send.bind(ledger);
  let staleDeliveryGate: Promise<void> | null = null;
  let releaseStaleDelivery: (() => void) | null = null;
  const gatedLedger = ledger as DeliveryLedger & {
    send: (...args: Parameters<DeliveryLedger["send"]>) => ReturnType<DeliveryLedger["send"]>;
  };
  gatedLedger.send = async (...args) => {
    const input = args[1] as { deliveryId?: string } | undefined;
    if (input?.deliveryId === STALE_DELIVERY_ID && staleDeliveryGate) {
      await staleDeliveryGate;
    }
    return originalLedgerSend(...args);
  };
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
    workspaceGitStub(root),
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
    gatedLedger,
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
      beginPluginHostInvocation: server.beginPluginHostInvocation.bind(server),
      endPluginHostInvocation: server.endPluginHostInvocation.bind(server),
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
  const runtimes = [runtime];
  let activeRuntime = runtime;
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
    home,
    movedCwd,
    parent,
    ledger,
    server,
    runtime,
    get activeRuntime() {
      return activeRuntime;
    },
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
        activeRuntime as unknown as {
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
      const reconnectRuntime = new PluginRuntime(logger, "conformance", {
        installationIdFactory: () => installationId,
        sessionHost: {
          attachPluginSocket: server.attachPluginSocket.bind(server),
          beginPluginShutdown: server.beginPluginShutdown.bind(server),
          finishPluginShutdown: server.finishPluginShutdown.bind(server),
          invokePluginHost: server.invokePluginHost.bind(server),
          beginPluginHostInvocation: server.beginPluginHostInvocation.bind(server),
          endPluginHostInvocation: server.endPluginHostInvocation.bind(server),
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
      runtimes.push(reconnectRuntime);
      activeRuntime = reconnectRuntime;
      return reconnectRuntime;
    },
    beginStaleDelivery() {
      if (staleDeliveryGate) throw new Error("stale delivery gate was already open");
      staleDeliveryGate = new Promise<void>((resolve) => {
        releaseStaleDelivery = resolve;
      });
    },
    releaseStaleDelivery() {
      const release = releaseStaleDelivery;
      releaseStaleDelivery = null;
      staleDeliveryGate = null;
      release?.();
    },
    async close() {
      for (const currentRuntime of runtimes) await currentRuntime.stopAll();
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
  runtime = fixture.activeRuntime,
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

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) fail(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function settleBounded<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 1_000,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; error: Error }>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({ ok: false, error: new Error(`${label} did not reject within ${timeoutMs}ms`) }),
      timeoutMs,
    );
  });
  const result = await Promise.race([settle(promise), timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

async function installationIdentity(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  runtime = fixture.activeRuntime,
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
      const created = (await invokeTool(fixture, { mode: "worktree.create" })) as Record<
        string,
        unknown
      >;
      const worktreeId = String(created.worktreeId);
      const worktreeCwd = String(created.worktreeCwd);
      assert(worktreeId.startsWith("managed:"), "worktree id was not opaque");
      assert(worktreeCwd !== worktreeId, "worktree id exposed its physical path");
      await access(worktreeCwd);
      const identity = await installationIdentity(fixture);
      const persisted = JSON.parse(
        await readFile(path.join(fixture.home, "plugin-managed-worktrees.json"), "utf8"),
      ) as { records?: Array<Record<string, unknown>> };
      const ownedRecord = persisted.records?.find((record) => record.id === worktreeId);
      assert(ownedRecord, "created worktree ownership was not persisted");
      equal(ownedRecord.pluginId, PLUGIN_ID, "persisted worktree plugin owner");
      equal(
        ownedRecord.installationId,
        identity.installationId,
        "persisted worktree installation owner",
      );
      equal(ownedRecord.callerAgentId, CALLER_AGENT_ID, "persisted worktree caller owner");

      let wrongCallerRejected = false;
      try {
        await invokeTool(fixture, { mode: "worktree.remove", worktreeId }, ATTACKER_AGENT_ID);
      } catch (error) {
        wrongCallerRejected = errorText(error).length > 0;
      }
      assert(wrongCallerRejected, "wrong caller removed the managed worktree");
      await access(worktreeCwd);

      const reconnectedRuntime = await fixture.reconnectPlugin(identity.installationId);
      const reconnectedIdentity = await installationIdentity(fixture, reconnectedRuntime);
      equal(
        reconnectedIdentity.installationId,
        identity.installationId,
        "worktree restart installation identity",
      );
      const removed = (await invokeTool(
        fixture,
        { mode: "worktree.remove", worktreeId },
        CALLER_AGENT_ID,
        reconnectedRuntime,
      )) as Record<string, unknown>;
      equal(removed.removedWorktreeId, worktreeId, "removed opaque worktree id");
      let physicallyRemoved = false;
      try {
        await access(worktreeCwd);
      } catch (error) {
        physicallyRemoved = (error as NodeJS.ErrnoException).code === "ENOENT";
      }
      assert(physicallyRemoved, "managed worktree directory was not physically removed");
      const afterRemoval = JSON.parse(
        await readFile(path.join(fixture.home, "plugin-managed-worktrees.json"), "utf8"),
      ) as { records?: Array<Record<string, unknown>> };
      assert(
        !afterRemoval.records?.some((record) => record.id === worktreeId),
        "removed worktree ownership remained persisted",
      );
      return {
        worktreeId,
        opaqueId: true,
        wrongCallerRejected,
        restartPreservedOwnership: true,
        physicalRemovalConfirmed: physicallyRemoved,
      };
    });
    await runCase(results, CASE_IDS[4], async () => {
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
    await runCase(results, CASE_IDS[5], async () => {
      let unauthorized = false;
      try {
        await invokeTool(fixture, { mode: "delivery" }, ATTACKER_AGENT_ID);
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
    await runCase(results, CASE_IDS[6], async () => {
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
    await runCase(results, CASE_IDS[7], async () => {
      const old = await installationIdentity(fixture);
      fixture.beginStaleDelivery();
      const oldOperation = settle(invokeTool(fixture, { mode: "stale" }));
      let oldInvocation: {
        invocationId: string;
        generation: number;
        installationId: string;
        capabilityNonce: string;
      } | null = null;
      let replacement!: Awaited<ReturnType<typeof installationIdentity>>;
      try {
        await waitFor(() => {
          const loaded = (
            fixture.activeRuntime as unknown as {
              plugins: Map<
                string,
                {
                  generation: number;
                  installationId: string;
                  pending: Map<
                    string,
                    { capabilityNonce: string; hostRequests: Map<string, string> }
                  >;
                }
              >;
            }
          ).plugins.get(PLUGIN_ID);
          if (!loaded) return false;
          const pending = [...loaded.pending.entries()].find(
            ([, invocation]) => invocation.hostRequests.size > 0,
          );
          if (!pending) return false;
          oldInvocation = {
            invocationId: pending[0],
            generation: loaded.generation,
            installationId: loaded.installationId,
            capabilityNonce: pending[1].capabilityNonce,
          };
          return true;
        });
        assert(oldInvocation, "old host invocation capability was not established");
        await fixture.activeRuntime.stopPluginById(PLUGIN_ID);
        await fixture.activeRuntime.startPlugin(PLUGIN_ID, fixture.pluginDirectory);
        replacement = await installationIdentity(fixture);
        assert(
          replacement.generation > old.generation,
          "replacement did not advance the attached generation",
        );
        equal(
          replacement.installationId,
          old.installationId,
          "replacement retained the reconnect installation principal",
        );
        fixture.releaseStaleDelivery();
        const oldSettled = await settleBounded(oldOperation, "stale host invocation", 3_000);
        assert(
          oldSettled.ok && !oldSettled.value.ok,
          "late stale host result was accepted by the old tool invocation",
        );

        const currentSession = fixture.server
          .listSessions()
          .find(
            (candidate) =>
              candidate.getPluginIdentity()?.pluginId === PLUGIN_ID &&
              candidate.getPluginIdentity()?.installationId === replacement.installationId,
          );
        assert(currentSession, "replacement Session was not attached to the production socket");
        const currentContext = await currentSession.resolvePluginToolContext(CALLER_AGENT_ID);
        assert(currentContext.caller, "replacement caller authority was not resolved");
        const probeInvocationId = "stale-session-probe";
        const probeNonce = "current-session-probe-nonce";
        fixture.server.beginPluginHostInvocation({
          pluginId: PLUGIN_ID,
          invocationId: probeInvocationId,
          generation: replacement.generation,
          installationId: replacement.installationId,
          capabilityNonce: probeNonce,
        });
        try {
          const staleGeneration = await settleBounded(
            fixture.server.invokePluginHost({
              pluginId: PLUGIN_ID,
              caller: currentContext.caller,
              invocationId: probeInvocationId,
              generation: old.generation,
              installationId: replacement.installationId,
              capabilityNonce: probeNonce,
              operation: "delivery.get",
              input: { options: { deliveryId: "stale-generation-side-effect" } },
              signal: new AbortController().signal,
            }),
            "stale generation session request",
          );
          assert(!staleGeneration.ok, "stale generation request crossed the attached Session");
          const staleNonce = await settleBounded(
            fixture.server.invokePluginHost({
              pluginId: PLUGIN_ID,
              caller: currentContext.caller,
              invocationId: probeInvocationId,
              generation: replacement.generation,
              installationId: replacement.installationId,
              capabilityNonce: oldInvocation.capabilityNonce,
              operation: "delivery.get",
              input: { options: { deliveryId: "stale-nonce-side-effect" } },
              signal: new AbortController().signal,
            }),
            "stale nonce session request",
          );
          assert(!staleNonce.ok, "stale nonce request crossed the attached Session");
        } finally {
          fixture.server.endPluginHostInvocation(
            PLUGIN_ID,
            replacement.installationId,
            probeInvocationId,
          );
        }
        const principal = `plugin:${PLUGIN_ID}:${replacement.installationId}`;
        for (const deliveryId of [
          STALE_DELIVERY_ID,
          "stale-generation-side-effect",
          "stale-nonce-side-effect",
        ]) {
          const record = await fixture.ledger.get(principal, {
            deliveryId,
            includeAcknowledged: true,
          });
          equal(record.delivery, null, `stale request side effect for ${deliveryId}`);
        }
      } finally {
        fixture.releaseStaleDelivery();
      }
      return {
        oldGeneration: old.generation,
        newGeneration: replacement.generation,
        staleGenerationRejected: true,
        staleNonceRejected: true,
        attachedSessionRouted: true,
        boundedRejection: true,
        noSideEffect: true,
        lateResultIgnored: true,
      };
    });
  } finally {
    await fixture.close();
  }
  return results;
}

const sourceRoot = verifySourceArgument(process.argv.slice(2));

if (process.argv.includes("--json")) {
  try {
    if (sourceRoot) await verifySource(sourceRoot);
    const cases = await runConformance();
    process.stdout.write(
      `${JSON.stringify({ sourceCommit: PASEO_SOURCE_COMMIT, caseIds: CASE_IDS, cases })}\n`,
    );
    if (cases.some((result) => result.ok !== true)) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ sourceCommit: PASEO_SOURCE_COMMIT, caseIds: CASE_IDS, cases: [], error: errorText(error) })}\n`,
    );
    process.exitCode = 1;
  }
} else {
  try {
    if (sourceRoot) await verifySource(sourceRoot);
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
