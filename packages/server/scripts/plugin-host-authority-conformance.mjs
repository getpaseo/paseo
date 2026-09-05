#!/usr/bin/env node

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";

import { DownloadTokenStore } from "../dist/server/server/file-download/token-store.js";
import {
  DeliveryDispatchCoordinator,
  DeliveryLedger,
} from "../dist/server/server/deliveries/delivery-ledger.js";
import { Session } from "../dist/server/server/session.js";
import { compilePlugin } from "../dist/server/server/plugins/compiler.js";
import { PluginRuntime } from "../dist/server/server/plugins/runtime.js";

const PLUGIN_ID = "authority-conformance";
const CALLER_AGENT_ID = "caller-agent";
const WORKSPACE_ID = "source-workspace";
const PROJECT_ID = "source-project";
const DELIVERY_ID = "authority-conformance-delivery";
const TIMESTAMP = "2026-09-05T00:00:00.000Z";

export const CONFORMANCE_CASE_NAMES = [
  "compiler.target-bounded-bundles",
  "runtime.compiles-loads-and-publishes-tool",
  "host.delivery.targets-live-caller-and-is-idempotent",
  "host.child.create-inherits-live-caller-authority",
  "host.stale-caller-is-rejected",
  "session.installation-fence-rejects-stale-installation",
];

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function createProject(root) {
  return {
    projectId: PROJECT_ID,
    rootPath: root,
    kind: "git",
    displayName: "Conformance project",
    projectKey: "conformance-project",
    customName: null,
    customIconRevision: null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    archivedAt: null,
  };
}

function createWorkspace(root) {
  return {
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    cwd: root,
    kind: "local_checkout",
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

function createAgent(id, root, options = {}) {
  const config = {
    provider: "codex",
    cwd: root,
    model: "caller-model",
    thinkingOptionId: "caller-thinking",
    modeId: "default",
    providerOptions: {
      sandbox_mode: "read-only",
      network_access: false,
      approval_policy: "never",
    },
    toolPolicy: {
      preapproved: [{ kind: "mcp", server: "review", tool: "read" }],
    },
    ...options.config,
  };
  return {
    id,
    provider: "codex",
    cwd: root,
    workspaceId: options.workspaceId ?? WORKSPACE_ID,
    lifecycle: options.lifecycle ?? "idle",
    config,
    runtimeInfo: undefined,
    createdAt: new Date(TIMESTAMP),
    updatedAt: new Date(TIMESTAMP),
    lastUserMessageAt: null,
    activeTurnId: null,
    activeTurnStartedAt: null,
    availableModes: [{ id: "default", label: "Default", isUnattended: false }],
    currentModeId: "default",
    features: [],
    pendingPermissions: new Map(),
    bufferedPermissionResolutions: new Map(),
    inFlightPermissionResponses: new Set(),
    pendingReplacement: false,
    persistence: null,
    historyPrimed: true,
    attention: { requiresAttention: false },
    foregroundTurnWaiters: new Set(),
    finalizedForegroundTurnIds: new Set(),
    unsubscribeSession: null,
    labels: options.labels ?? {},
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
  };
}

function createCallerAuthority(agent, workspace, project) {
  return {
    callerAgentId: agent.id,
    agent: {
      id: agent.id,
      workspaceId: agent.workspaceId,
      provider: agent.provider,
      status: agent.lifecycle,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
      lastActivityAt: agent.updatedAt.toISOString(),
      title: null,
      cwd: agent.cwd,
      model: agent.config.model,
      currentModeId: agent.currentModeId,
      thinkingOptionId: agent.config.thinkingOptionId,
      requiresAttention: false,
      attentionReason: null,
      parentAgentId: agent.labels["paseo.parentAgentId"] ?? null,
      labels: agent.labels,
    },
    workspace: {
      id: workspace.workspaceId,
      projectId: workspace.projectId,
      projectDisplayName: project.displayName,
      projectRootPath: project.rootPath,
      directory: workspace.cwd,
      projectKind: project.kind,
      kind: workspace.kind,
      name: workspace.displayName,
      title: workspace.title,
      status: "done",
      statusEnteredAt: TIMESTAMP,
      archivingAt: workspace.archivedAt,
      diffStat: null,
    },
    effective: {
      provider: { known: true, value: agent.provider },
      model: { known: true, value: agent.config.model },
      thinking: { known: true, value: agent.config.thinkingOptionId },
      providerSessionId: { known: false },
    },
    securityCeiling: {
      filesystem: "unknown",
      network: "unknown",
      approvals: "preapproved",
      unattended: "forbidden",
    },
  };
}

function createPluginSource() {
  return `import { z } from "zod";
import { defineTool } from "@getpaseo/plugin/server";

const authorityTool = defineTool({
  name: "conformance.host_authority",
  title: "Host authority conformance",
  description: "Exercise the invocation-scoped host authority contract.",
  input: z.object({
    mode: z.enum(["delivery", "child"]),
    forgedTargetId: z.string().optional(),
  }),
  async handler(input, context) {
    if (input.mode === "delivery") {
      const payload = { kind: "conformance", forgedTargetId: input.forgedTargetId ?? null };
      const first = await context.host.deliveries.send(payload, {
        deliveryId: "${DELIVERY_ID}",
        messageId: "authority-conformance-message",
      });
      const second = await context.host.deliveries.send(payload, {
        deliveryId: "${DELIVERY_ID}",
        messageId: "authority-conformance-message",
      });
      const acknowledged = await context.host.deliveries.acknowledge("${DELIVERY_ID}");
      const fetched = await context.host.deliveries.get({
        deliveryId: "${DELIVERY_ID}",
        includeAcknowledged: true,
      });
      return {
        callerAgentId: context.caller.callerAgentId,
        callerCwd: context.caller.agent.cwd,
        targetAgentId: first.targetAgentId ?? null,
        firstStatus: first.status,
        secondStatus: second.status,
        acknowledgedStatus: acknowledged.status,
        fetchedStatus: fetched.delivery?.status ?? null,
        sameSequence: first.sequence === second.sequence,
      };
    }

    const child = await context.host.children.create({ title: "Conformance child" });
    return {
      callerAgentId: context.caller.callerAgentId,
      callerCwd: context.caller.agent.cwd,
      childAgentId: child.agentId,
      childParentAgentId: child.parentAgentId,
      childCwd: child.cwd,
      childProvider: child.provider,
      childModel: child.model,
      childThinking: child.thinking,
    };
  },
});

export default function contribute(plugin) {
  plugin.addTool(authorityTool);
  return () => undefined;
}
`;
}

async function createSessionFixture({
  home,
  project,
  workspace,
  agentManager,
  ledger,
  coordinator,
  pluginIdentity,
  dispatchCalls,
}) {
  const logger = pino({ level: "silent" });
  const projectRegistry = {
    list: async () => [project],
    get: async (projectId) => (projectId === project.projectId ? project : null),
    subscribeToMutations: () => () => {},
    update: async () => null,
  };
  const workspaceRegistry = {
    list: async () => [workspace],
    get: async (workspaceId) => (workspaceId === workspace.workspaceId ? workspace : null),
    subscribeToMutations: () => () => {},
    update: async () => null,
  };
  const workspaceGitService = {
    peekSnapshot: () => null,
    registerWorkspace: () => () => {},
    resolveForge: async () => ({ forge: "github", service: {} }),
  };
  const providerSnapshotManager = {
    on: () => providerSnapshotManager,
    off: () => providerSnapshotManager,
    resolveCreateConfig: async () => ({ modeId: "default", featureValues: undefined }),
    getSnapshot: () => [],
    listProviderAvailability: () => [],
    listDraftFeatures: async () => [],
    listProviders: async () => [],
  };
  const agentStorage = {
    get: async () => undefined,
    list: async () => [],
    listByProviderSession: async () => [],
    listByWorkspace: async () => [],
  };
  const daemonConfigStore = {
    get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
    reload: async () => {},
    onChange: () => () => {},
  };
  const session = new Session({
    clientId: `plugin:${pluginIdentity.pluginId}`,
    principalId: `plugin:${pluginIdentity.pluginId}:${pluginIdentity.installationId}`,
    pluginIdentity,
    permissions: [],
    onMessage: () => {},
    logger,
    downloadTokenStore: new DownloadTokenStore({ ttlMs: 60_000 }),
    pushNotifications: {},
    paseoHome: home,
    agentManager,
    agentStorage,
    deliveryLedger: ledger,
    deliveryDispatchCoordinator: coordinator,
    deliveryAgentDispatcher: async (input) => {
      dispatchCalls.push(input);
      return { outcome: "accepted" };
    },
    projectRegistry,
    workspaceRegistry,
    scheduleService: {},
    checkoutDiffManager: { scheduleRefreshForCwd: () => {} },
    github: {
      invalidate: async () => {},
      searchIssuesAndPrs: async () => [],
      createPullRequest: async () => ({}),
      mergePullRequest: async () => ({}),
    },
    workspaceGitService,
    workspaceAutoName: {},
    daemonConfigStore,
    stt: null,
    tts: null,
    terminalManager: null,
    providerSnapshotManager,
    providerUsageService: { listUsage: async () => [] },
    serverId: "plugin-authority-conformance",
    daemonVersion: "conformance",
  });
  session.agentUpdates.forwardLiveAgent = async () => {};
  return session;
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-plugin-authority-conformance-"));
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const project = createProject(root);
  const workspace = createWorkspace(root);
  let liveAgent = createAgent(CALLER_AGENT_ID, root);
  let childAgent = createAgent("child-agent", root, {
    labels: { "paseo.parentAgentId": CALLER_AGENT_ID },
  });
  const dispatchCalls = [];
  const createAgentCalls = [];
  const ledger = new DeliveryLedger(path.join(home, "deliveries"));
  const coordinator = new DeliveryDispatchCoordinator();
  const sessions = new Map();
  const ledgerOwners = new Map();

  const agentManager = {
    getAgent: (agentId) => {
      if (agentId === CALLER_AGENT_ID) return liveAgent;
      if (agentId === childAgent.id) return childAgent;
      return null;
    },
    subscribe: () => () => {},
    listAgents: () => [],
    listProviderAvailability: () => [],
    listDraftFeatures: async () => [],
    listProviderSubagentActivity: () => [],
    hasInFlightRun: () => false,
    createAgent: async (config, _unused, options) => {
      createAgentCalls.push({ config, options });
      childAgent = createAgent("child-agent", config.cwd, {
        workspaceId: options.workspaceId,
        config,
        labels: options.labels,
      });
      return childAgent;
    },
  };

  const attachSession = async (pluginId, socket, installationId) => {
    const principalId = `plugin:${pluginId}:${installationId}`;
    const pluginIdentity = { pluginId, installationId };
    const session = await createSessionFixture({
      home,
      project,
      workspace,
      agentManager,
      ledger,
      coordinator,
      pluginIdentity,
      dispatchCalls,
    });
    sessions.set(`${pluginId}:${installationId}`, session);
    ledgerOwners.set(pluginId, principalId);
    const closed = new Promise((resolve) => {
      socket.once("close", () => {
        void session.cleanup().finally(resolve);
      });
    });
    socket.on("message", (data) => {
      if (typeof data !== "string") return;
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message?.type !== "hello") return;
      socket.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "status",
            payload: {
              status: "server_info",
              serverId: "plugin-authority-conformance",
              hostname: "plugin-authority-conformance",
              version: "conformance",
              features: {
                durableDeliveries: true,
                durableDeliveryTargeting: true,
                pluginCallerHostApis: true,
              },
            },
          },
        }),
      );
    });
    return { closed };
  };

  const sessionHost = {
    attachPluginSocket: attachSession,
    invokePluginHost: async (input) => {
      const session = sessions.get(`${input.pluginId}:${input.installationId}`);
      if (!session) throw new Error("Plugin session is unavailable");
      return session.invokePluginHost(input);
    },
    beginPluginShutdown: (pluginId) => {
      const principalId = ledgerOwners.get(pluginId);
      if (!principalId) return;
      coordinator.beginOwnerClosing(principalId);
      ledger.beginOwnerClosing(principalId);
    },
    finishPluginShutdown: async (pluginId, installationId) => {
      const key = `${pluginId}:${installationId}`;
      const session = sessions.get(key);
      if (session) {
        await session.finishPluginShutdown(pluginId, installationId);
        await session.cleanup();
        sessions.delete(key);
      }
      const principalId = `plugin:${pluginId}:${installationId}`;
      await ledger.reconcile(principalId).catch(() => {});
      await ledger.removeOwner(principalId).catch(() => {});
      coordinator.finishOwner(principalId);
      ledgerOwners.delete(pluginId);
    },
  };

  const callerAuthority = () => createCallerAuthority(liveAgent, workspace, project);
  const resolveToolContext = async (callerAgentId) => ({
    callerAgentId,
    agent: callerAgentId === CALLER_AGENT_ID ? callerAuthority().agent : null,
    workspace: callerAgentId === CALLER_AGENT_ID ? callerAuthority().workspace : null,
    caller: callerAgentId === CALLER_AGENT_ID ? callerAuthority() : null,
  });
  const runtime = new PluginRuntime(pino({ level: "silent" }), "conformance", {
    sessionHost,
    resolveToolContext,
  });
  const pluginDirectory = path.join(root, "plugin");
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({ id: PLUGIN_ID }),
  );
  await writeFile(path.join(pluginDirectory, "index.ts"), createPluginSource());
  return {
    root,
    home,
    project,
    workspace,
    runtime,
    pluginDirectory,
    ledger,
    dispatchCalls,
    createAgentCalls,
    sessions,
    callerAuthority,
    setCallerLifecycle(lifecycle) {
      liveAgent = { ...liveAgent, lifecycle };
    },
    getCallerAgent() {
      return liveAgent;
    },
    async close() {
      await runtime.stopAll();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function runCase(cases, name, operation) {
  try {
    const details = await operation();
    cases.push({ case: name, ok: true, details });
  } catch (error) {
    cases.push({ case: name, ok: false, error: describeError(error) });
  }
}

async function runCompilerCase() {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-compiler-conformance-"));
  try {
    const entryPath = path.join(directory, "index.ts");
    await writeFile(
      entryPath,
      `import { surface } from "./main.client";
import { handler, ping } from "./service.server";

export default function contribute(plugin) {
  plugin.handle(ping, handler);
  plugin.addSurface("main", surface);
  return () => undefined;
}
`,
    );
    await writeFile(
      path.join(directory, "main.client.ts"),
      `export function surface() { return "client-surface"; }\n`,
    );
    await writeFile(
      path.join(directory, "service.server.ts"),
      `export const ping = { name: "ping", input: {}, output: {} };\nexport function handler() { return "server-handler"; }\n`,
    );
    const { clientBundle, serverBundle } = await compilePlugin(entryPath);
    assert(clientBundle.includes("client-surface"), "client bundle lost client contribution");
    assert(!clientBundle.includes("server-handler"), "client bundle retained server contribution");
    assert(serverBundle.includes("server-handler"), "server bundle lost server contribution");
    assert(!serverBundle.includes("client-surface"), "server bundle retained client contribution");
    return { clientHasClientCode: true, serverHasServerCode: true, bundlesAreBounded: true };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runConformance() {
  const cases = [];
  await runCase(cases, "compiler.target-bounded-bundles", runCompilerCase);
  const fixture = await createFixture();
  try {
    await runCase(cases, "runtime.compiles-loads-and-publishes-tool", async () => {
      await fixture.runtime.startPlugin(PLUGIN_ID, fixture.pluginDirectory);
      const catalog = fixture.runtime.toolCatalog();
      assertEqual(catalog.length, 1, "published tool count");
      assertEqual(catalog[0]?.name, "conformance.host_authority", "published tool name");
      return { tool: catalog[0].name, compiledAndPublished: true };
    });
    await runCase(cases, "host.delivery.targets-live-caller-and-is-idempotent", async () => {
      const result = await fixture.runtime.invokeTool(
        PLUGIN_ID,
        "conformance.host_authority",
        { mode: "delivery", forgedTargetId: "attacker-agent" },
        { callerAgentId: CALLER_AGENT_ID },
      );
      assertEqual(result.callerAgentId, CALLER_AGENT_ID, "delivery caller identity");
      assertEqual(result.targetAgentId, CALLER_AGENT_ID, "delivery target identity");
      assertEqual(result.firstStatus, "accepted", "first delivery status");
      assertEqual(result.secondStatus, "accepted", "idempotent retry status");
      assertEqual(result.acknowledgedStatus, "acknowledged", "acknowledgement status");
      assertEqual(result.fetchedStatus, "acknowledged", "ledger read status");
      assertEqual(result.sameSequence, true, "idempotent retry sequence");
      assertEqual(fixture.dispatchCalls.length, 1, "native dispatch count");
      assertEqual(
        fixture.dispatchCalls[0].targetAgentId,
        CALLER_AGENT_ID,
        "native target identity",
      );
      return {
        targetAgentId: result.targetAgentId,
        dispatchCount: fixture.dispatchCalls.length,
        retryReusedSequence: result.sameSequence,
        acknowledged: result.fetchedStatus === "acknowledged",
      };
    });
    await runCase(cases, "host.child.create-inherits-live-caller-authority", async () => {
      const result = await fixture.runtime.invokeTool(
        PLUGIN_ID,
        "conformance.host_authority",
        { mode: "child" },
        { callerAgentId: CALLER_AGENT_ID },
      );
      const call = fixture.createAgentCalls.at(-1);
      assert(call, "child creation did not reach AgentManager");
      assertEqual(result.childParentAgentId, CALLER_AGENT_ID, "child parent identity");
      assertEqual(result.childCwd, fixture.getCallerAgent().cwd, "child cwd inheritance");
      assertEqual(call.config.provider, "codex", "child provider inheritance");
      assertEqual(call.config.model, "caller-model", "child model inheritance");
      assertEqual(call.config.thinkingOptionId, "caller-thinking", "child thinking inheritance");
      assertEqual(call.config.modeId, "default", "child mode inheritance");
      assertEqual(
        call.config.providerOptions.network_access,
        false,
        "child provider option inheritance",
      );
      assert(call.config.toolPolicy.preapproved.length === 1, "child tool policy inheritance");
      return { parentAgentId: result.childParentAgentId, inherited: true, cwd: result.childCwd };
    });
    await runCase(cases, "host.stale-caller-is-rejected", async () => {
      fixture.setCallerLifecycle("closed");
      try {
        await fixture.runtime.invokeTool(
          PLUGIN_ID,
          "conformance.host_authority",
          { mode: "delivery" },
          { callerAgentId: CALLER_AGENT_ID },
        );
        throw new Error("stale caller invocation unexpectedly succeeded");
      } catch (error) {
        assert(
          describeError(error).includes("Caller agent is no longer active"),
          "unexpected stale caller error",
        );
        return { rejected: true, reason: "caller_no_longer_active" };
      } finally {
        fixture.setCallerLifecycle("idle");
      }
    });
    await runCase(cases, "session.installation-fence-rejects-stale-installation", async () => {
      const [session] = fixture.sessions.values();
      assert(session, "plugin session was not attached");
      try {
        await session.invokePluginHost({
          pluginId: PLUGIN_ID,
          caller: fixture.callerAuthority(),
          invocationId: "stale-installation-invocation",
          generation: 1,
          installationId: "stale-installation",
          capabilityNonce: "stale-nonce",
          operation: "delivery.get",
          input: {},
          signal: new AbortController().signal,
        });
        throw new Error("stale installation unexpectedly succeeded");
      } catch (error) {
        assert(
          describeError(error).includes("installation is not authorized"),
          "unexpected installation fence error",
        );
        return { rejected: true, reason: "installation_identity_mismatch" };
      }
    });
  } finally {
    await fixture.close();
  }
  return cases;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const cases = await runConformance();
    for (const result of cases) process.stdout.write(`${JSON.stringify(result)}\n`);
    if (cases.some((result) => !result.ok)) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ case: "harness", ok: false, error: describeError(error) })}\n`,
    );
    process.exitCode = 1;
  }
}
