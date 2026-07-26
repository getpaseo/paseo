import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createTestLogger } from "../test-utils/test-logger.js";
import { isPlatform } from "../test-utils/platform.js";
import { Session } from "./session.js";
import {
  asAgentManager,
  asAgentStorage,
  asChatService,
  asCheckoutDiffManager,
  asDaemonConfigStore,
  asDownloadTokenStore,
  asPushTokenStore,
  asScheduleService,
  asLoopService,
  asSessionLogger,
  asSessionInternals,
  createProviderSnapshotManagerStub,
} from "./test-utils/session-stubs.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  type PersistedWorkspaceRecord,
} from "./workspace-registry.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type {
  ContainerBackend,
  ContainerInfo,
  ContainerRef,
  ContainerUpOptions,
  ExecutionHandle,
} from "./devcontainer/container-backend.js";
import { createDevContainerBackend, createLaunchStrategyRegistry } from "./devcontainer/index.js";
import { createContainerBackendRegistry } from "./devcontainer/container-backend-registry.js";
import { ContainerProbeCoordinator } from "./devcontainer/container-probe-coordinator.js";
import { createLaunchFileSystem } from "./devcontainer/launch-filesystem.js";
import { ClaudeAgentClient } from "./agent/providers/claude/agent.js";
import {
  ContainerExecLaunchStrategy,
  LocalLaunchStrategy,
  deserializeLaunchStrategy,
  resolveContainerEnvEntries,
} from "./devcontainer/launch-strategy.js";
import { execCommand } from "../utils/spawn.js";

// ---------------------------------------------------------------------------
const HANDLE: ExecutionHandle = {
  identifier: "abc123def456",
  remoteUser: "root",
  remoteWorkspaceFolder: "/workspaces/test",
};

/** The docker exec spec the dev container backend builds for a running container. */
function dockerExecStrategy(
  handle: ExecutionHandle,
  hostWorkspaceFolder: string,
): ContainerExecLaunchStrategy {
  return new ContainerExecLaunchStrategy({
    command: "docker",
    leadingArgs: ["exec"],
    optionArgs: ["-i", "-u", handle.remoteUser],
    targetArgs: [handle.identifier],
    workdirFlag: "-w",
    envFlag: "-e",
    ttyArgs: ["-t"],
    hostWorkspaceFolder,
    remoteWorkspaceFolder: handle.remoteWorkspaceFolder,
  });
}

function createMockContainerBackend(
  options: {
    hasConfig?: (cwd: string) => boolean;
    isAvailable?: () => Promise<boolean>;
    isAlreadyRunning?: (ref: ContainerRef) => Promise<boolean>;
    configHash?: string | null;
  } = {},
): ContainerBackend {
  const handles = new Map<string, ExecutionHandle>();
  return {
    id: "devcontainer",
    label: "Dev Container",
    isAvailable: options.isAvailable ?? (async () => true),
    hasConfig: options.hasConfig ?? (() => false),
    async up(opts: ContainerUpOptions) {
      const existing = handles.get(opts.key);
      if (existing) return existing;
      handles.set(opts.key, HANDLE);
      return HANDLE;
    },
    async restart(opts: ContainerUpOptions) {
      handles.delete(opts.key);
      handles.set(opts.key, HANDLE);
      return HANDLE;
    },
    async rebuild(opts: ContainerUpOptions) {
      handles.delete(opts.key);
      handles.set(opts.key, HANDLE);
      return HANDLE;
    },
    async stop(ref: ContainerRef) {
      handles.delete(ref.key);
    },
    getHandle(key: string) {
      return handles.get(key) ?? null;
    },
    getContainerInfo(key: string) {
      const h = handles.get(key);
      if (!h) return null;
      return {
        backend: "devcontainer",
        backendLabel: "Dev Container",
        containerId: h.identifier.slice(0, 12),
        containerName: "test-container",
        image: "test:latest",
        startedAt: "2026-07-26T00:00:00.000Z",
        remoteUser: h.remoteUser,
      } satisfies ContainerInfo;
    },
    getConfigHash(_cwd: string) {
      return options.configHash ?? "hash-123";
    },
    isAlreadyRunning: options.isAlreadyRunning ?? (async (_ref: ContainerRef) => false),
    async removeAbandonedProbeContainers() {
      return 0;
    },
    createStrategy: () => new LocalLaunchStrategy(),
  };
}

function createContainerTestSession(options: {
  backend: ContainerBackend;
  providerSnapshotManager?: ProviderSnapshotManager;
}): Session {
  const logger = createTestLogger();
  const emitted = options.emitted ?? [];

  const tmpDir = mkdtempSync(path.join(tmpdir(), "paseo-container-test-"));
  const workspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(tmpDir, "workspaces.json"),
    logger,
  );
  const projectRegistry = new FileBackedProjectRegistry(path.join(tmpDir, "projects.json"), logger);

  // Seed registries
  void workspaceRegistry.initialize();
  void projectRegistry.initialize();
  for (const ws of options.workspaces ?? []) {
    void workspaceRegistry.upsert(ws);
    void projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: ws.projectId,
        rootPath: ws.cwd,
        kind: "non_git",
        displayName: ws.displayName,
        createdAt: ws.createdAt,
        updatedAt: ws.updatedAt,
      }),
    );
  }

  const launchStrategyRegistry = createLaunchStrategyRegistry({
    logger,
    createStrategy: options.backend.createStrategy,
  });

  const agentManager = asAgentManager({
    subscribe: () => () => {},
    listAgents: () => [],
    getAgent: () => null,
    archiveAgent: async () => ({ archivedAt: new Date().toISOString() }),
    archiveSnapshot: async () => ({}),
    unarchiveSnapshot: async () => true,
    clearAgentAttention: async () => {},
    notifyAgentState: () => {},
    cancelAgentRun: async () => ({ status: "cancelled" }),
  });

  const session = new Session({
    clientId: "test-client",
    scopes: ["*"],
    appVersion: "0.2.0",
    onMessage: (msg: SessionOutboundMessage) => emitted.push(msg),
    logger: asSessionLogger(logger),
    downloadTokenStore: asDownloadTokenStore(),
    pushTokenStore: asPushTokenStore(),
    paseoHome: tmpDir,
    agentManager,
    agentStorage: asAgentStorage({
      list: async () => [],
      get: async () => null,
      upsert: async () => {},
    }),
    projectRegistry,
    workspaceRegistry,
    filesystem: { isDirectory: async () => true },
    chatService: asChatService(),
    scheduleService: asScheduleService(),
    loopService: asLoopService(),
    checkoutDiffManager: asCheckoutDiffManager({
      subscribe: async () => ({
        initial: { cwd: "/tmp", files: [], error: null },
        unsubscribe: () => {},
      }),
      scheduleRefreshForCwd: () => {},
      onWorkspaceStateMayHaveChanged: () => {},
      invalidateForge: () => {},
      getMetrics: () => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      }),
      dispose: () => {},
    }),
    workspaceGitService: createNoopWorkspaceGitService(),
    workspaceAutoName: new WorkspaceAutoName({
      agentManager,
      workspaceRegistry,
      workspaceGitService: createNoopWorkspaceGitService(),
      providerSnapshotManager:
        options.providerSnapshotManager ?? createProviderSnapshotManagerStub().manager,
      readDaemonConfig: () => ({ metadataGeneration: { providers: [] } }),
      gitMutation: { notifyGitMutation: async () => {} },
      emitWorkspaceUpdateForCwd: async () => {},
      emitWorkspaceUpdateForWorkspaceId: async () => {},
      logger: asSessionLogger(logger),
    }),
    daemonConfigStore: asDaemonConfigStore({
      get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
      onChange: () => () => {},
    }),
    mcpBaseUrl: null,
    stt: null,
    tts: null,
    providerSnapshotManager:
      options.providerSnapshotManager ?? createProviderSnapshotManagerStub().manager,
    terminalManager: null,
    containerBackends: createContainerBackendRegistry([options.backend]),
    launchStrategyRegistry,
  });

  return session;
}

function makeWorkspace(
  overrides: Partial<PersistedWorkspaceRecord> = {},
): PersistedWorkspaceRecord {
  return createPersistedWorkspaceRecord({
    workspaceId: "ws-test",
    projectId: "proj-test",
    cwd: "/tmp/test-workspace",
    kind: "directory",
    displayName: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function makeDevcontainerDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-devcontainer-"));
  writeFileSync(path.join(dir, ".devcontainer.json"), '{"image":"test:latest"}');
  return dir;
}

// Advance the microtask queue enough for the fire-and-forget IIFE inside
// maybeStartContainerForWorkspace to progress past its awaited availability /
// already-running checks and register a pending activation. Deterministic —
// no real timers.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("describeWorkspaceRecord starts container directly when containerBackend is devcontainer", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const upSpy = vi.fn(async () => HANDLE);
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });
  backend.up = upSpy;

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<unknown>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerBackend: "devcontainer" });
  // describeWorkspaceRecord awaits maybeStartContainerForWorkspace, which awaits
  // the IIFE to completion — so up has been called by the time this resolves.
  await internals.describeWorkspaceRecord(workspace);

  expect(upSpy).toHaveBeenCalledWith(
    expect.objectContaining({ key: "ws-test", kind: "workspace", workspaceFolder: cwd }),
  );
});

test("describeWorkspaceRecord does not start container when containerBackend is host", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const upSpy = vi.fn(async () => HANDLE);
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });
  backend.up = upSpy;

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: null })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<unknown>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerBackend: null });
  await internals.describeWorkspaceRecord(workspace);

  expect(upSpy).not.toHaveBeenCalled();
});

test("describeWorkspaceRecord reuses existing container when isAlreadyRunning returns true", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const upSpy = vi.fn(async () => HANDLE);
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => true,
  });
  backend.up = upSpy;

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<unknown>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerBackend: "devcontainer" });
  await internals.describeWorkspaceRecord(workspace);

  expect(upSpy).toHaveBeenCalled();
});

test("describeWorkspaceRecord does not trigger container flow when no devcontainer.json exists", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-nocontainer-"));
  const emitted: SessionOutboundMessage[] = [];
  const upSpy = vi.fn(async () => HANDLE);
  const backend = createMockContainerBackend({
    hasConfig: () => false,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });
  backend.up = upSpy;

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<unknown>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerBackend: "devcontainer" });
  await internals.describeWorkspaceRecord(workspace);

  expect(upSpy).not.toHaveBeenCalled();
});

test("describeWorkspaceRecord includes containerStatus running when container is running", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => true,
  });

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<{
      containerStatus?: string;
      hasDevContainerConfig?: boolean;
    }>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerBackend: "devcontainer" });
  const descriptor = await internals.describeWorkspaceRecord(workspace);

  expect(descriptor.containerStatus).toBe("running");
  expect(descriptor.hasDevContainerConfig).toBe(true);
});

test("the workspace descriptor carries the running container's details", async () => {
  // The badge tooltip names the backend, image and user; it can only do that if
  // the descriptor carries them. They must also arrive without a follow-up
  // workspace update — a descriptor build is what a workspace update produces,
  // so a build that emits one loops.
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => true,
  });

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<{
      containerInfo?: { backend: string; backendLabel?: string; image: string } | null;
    }>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerBackend: "devcontainer" });
  await internals.describeWorkspaceRecord(workspace);
  await flushMicrotasks();
  const descriptor = await internals.describeWorkspaceRecord(workspace);

  expect(descriptor.containerInfo).toMatchObject({
    backend: "devcontainer",
    backendLabel: "Dev Container",
    image: "test:latest",
  });
  expect(emitted.filter((m) => m.type === "workspace_update")).toHaveLength(0);
});

test("describeWorkspaceRecord includes containerStatus starting while container is starting", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  // Block backend.up so the IIFE registers a pending activation and stalls —
  // this is the window where containerStatus is "starting".
  const { promise: upPromise, resolve: resolveUp } = Promise.withResolvers<ExecutionHandle>();
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });
  backend.up = vi.fn(() => upPromise);

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
    emitted,
  });

  const internals = asSessionInternals<{
    maybeStartContainerForWorkspace: (workspace: PersistedWorkspaceRecord) => Promise<void>;
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<{
      containerStatus?: string;
      hasDevContainerConfig?: boolean;
    }>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerBackend: "devcontainer" });
  // Kick off the container start without awaiting — the IIFE registers a
  // pending activation then blocks on the controlled up promise.
  const startPromise = internals.maybeStartContainerForWorkspace(workspace);
  await flushMicrotasks();

  // A second describeWorkspaceRecord sees the pending activation (the first
  // call's maybeStartContainerForWorkspace returns early) and reports "starting"
  // without blocking.
  const descriptor = await internals.describeWorkspaceRecord(workspace);
  expect(descriptor.containerStatus).toBe("starting");
  expect(descriptor.hasDevContainerConfig).toBe(true);

  // Complete the container start and let the IIFE finish.
  resolveUp(HANDLE);
  await startPromise;
});

test("host backend does not get container even if another workspace with same cwd is devcontainer", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });

  const session = createContainerTestSession({
    backend,
    workspaces: [
      makeWorkspace({ workspaceId: "ws-dev", cwd, containerBackend: "devcontainer" }),
      makeWorkspace({ workspaceId: "ws-host", cwd, containerBackend: null }),
    ],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<{
      containerStatus?: string;
    }>;
  }>(session);

  // First, start the container for the devcontainer workspace
  const devWs = makeWorkspace({
    workspaceId: "ws-dev",
    cwd,
    containerBackend: "devcontainer",
  });
  await internals.describeWorkspaceRecord(devWs);

  // Now describe the host workspace — it should not have containerStatus
  const hostWs = makeWorkspace({ workspaceId: "ws-host", cwd, containerBackend: null });
  const hostDescriptor = await internals.describeWorkspaceRecord(hostWs);

  expect(hostDescriptor.containerStatus).toBeUndefined();
});

test("container.restart.request stops and restarts the container", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const restartSpy = vi.fn(async () => HANDLE);
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });
  backend.restart = restartSpy;

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
    emitted,
  });

  const internals = asSessionInternals<{
    handleContainerRestartRequest: (msg: {
      type: "container.restart.request";
      workspaceId: string;
      requestId: string;
    }) => Promise<void>;
  }>(session);

  await internals.handleContainerRestartRequest({
    type: "container.restart.request",
    workspaceId: "ws-test",
    requestId: "req-1",
  });

  expect(restartSpy).toHaveBeenCalledWith(
    expect.objectContaining({ key: "ws-test", kind: "workspace", workspaceFolder: cwd }),
  );
  const response = emitted.find((m) => m.type === "container.restart.response");
  expect(response).toBeDefined();
  if (response && response.type === "container.restart.response") {
    expect(response.payload.containerStatus).toBe("running");
    expect(response.payload.error).toBeNull();
  }
});

test("container.restart.request returns error when workspace is not found", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const restartSpy = vi.fn(async () => HANDLE);
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });
  backend.restart = restartSpy;

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
    emitted,
  });

  const internals = asSessionInternals<{
    handleContainerRestartRequest: (msg: {
      type: "container.restart.request";
      workspaceId: string;
      requestId: string;
    }) => Promise<void>;
  }>(session);

  await internals.handleContainerRestartRequest({
    type: "container.restart.request",
    workspaceId: "ws-missing",
    requestId: "req-1",
  });

  expect(restartSpy).not.toHaveBeenCalled();
  const response = emitted.find((m) => m.type === "container.restart.response");
  expect(response).toBeDefined();
  if (response && response.type === "container.restart.response") {
    expect(response.payload.containerStatus).toBeNull();
    expect(response.payload.error).toBe("Workspace not found");
  }
});

test("container.availability.request returns docker availability and config detection", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
  });

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
    emitted,
  });

  const internals = asSessionInternals<{
    handleContainerAvailabilityRequest: (msg: {
      type: "container.availability.request";
      cwd: string;
      requestId: string;
    }) => Promise<void>;
  }>(session);

  await internals.handleContainerAvailabilityRequest({
    type: "container.availability.request",
    cwd,
    requestId: "req-1",
  });

  const response = emitted.find((m) => m.type === "container.availability.response");
  expect(response).toBeDefined();
  if (response && response.type === "container.availability.response") {
    expect(response.payload.backends).toEqual([
      { id: "devcontainer", label: "Dev Container", available: true, hasConfig: true },
    ]);
  }
});

test("container.availability.request returns false when docker unavailable and no config", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-nocontainer-"));
  const emitted: SessionOutboundMessage[] = [];
  const backend = createMockContainerBackend({
    hasConfig: () => false,
    isAvailable: async () => false,
  });

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: null })],
    emitted,
  });

  const internals = asSessionInternals<{
    handleContainerAvailabilityRequest: (msg: {
      type: "container.availability.request";
      cwd: string;
      requestId: string;
    }) => Promise<void>;
  }>(session);

  await internals.handleContainerAvailabilityRequest({
    type: "container.availability.request",
    cwd,
    requestId: "req-1",
  });

  const response = emitted.find((m) => m.type === "container.availability.response");
  expect(response).toBeDefined();
  if (response && response.type === "container.availability.response") {
    expect(response.payload.backends).toEqual([
      { id: "devcontainer", label: "Dev Container", available: false, hasConfig: false },
    ]);
  }
});

test("container.probe.request answers with the entries found in the container", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const backend = createMockContainerBackend({ hasConfig: () => true });
  const snapshotStub = createProviderSnapshotManagerStub();
  const containerEntry = {
    provider: "claude" as const,
    status: "ready" as const,
    enabled: true,
    models: [{ id: "container-model", name: "Container Model" }],
  };
  snapshotStub.probeSnapshotForCwd.mockResolvedValue([containerEntry]);

  const session = createContainerTestSession({
    backend,
    providerSnapshotManager: snapshotStub.manager,
    workspaces: [],
    emitted,
  });

  const internals = asSessionInternals<{
    handleContainerProbeRequest: (msg: {
      type: "container.probe.request";
      cwd: string;
      containerBackend: string;
      requestId: string;
    }) => Promise<void>;
  }>(session);

  await internals.handleContainerProbeRequest({
    type: "container.probe.request",
    cwd,
    containerBackend: "devcontainer",
    requestId: "req-1",
  });

  const response = emitted.find((m) => m.type === "container.probe.response");
  expect(response).toBeDefined();
  if (response?.type !== "container.probe.response") throw new Error("unreachable");
  expect(response.payload.success).toBe(true);
  expect(response.payload.cancelled).toBe(false);
  // The probe container is gone by now, so the client cannot ask again — these
  // entries have to be the whole answer.
  expect(response.payload.entries).toEqual([containerEntry]);
  // The shared snapshot for this directory is left alone: workspaces already
  // open on it are not running in this throwaway container.
  expect(snapshotStub.refreshSnapshotForCwd).not.toHaveBeenCalled();
});

test("container.probe.request reports a failure instead of pretending it succeeded", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const backend = createMockContainerBackend({ hasConfig: () => true });
  const snapshotStub = createProviderSnapshotManagerStub();
  snapshotStub.probeSnapshotForCwd.mockRejectedValue(new Error("container exploded"));

  const session = createContainerTestSession({
    backend,
    providerSnapshotManager: snapshotStub.manager,
    workspaces: [],
    emitted,
  });

  const internals = asSessionInternals<{
    handleContainerProbeRequest: (msg: {
      type: "container.probe.request";
      cwd: string;
      containerBackend: string;
      requestId: string;
    }) => Promise<void>;
  }>(session);

  await internals.handleContainerProbeRequest({
    type: "container.probe.request",
    cwd,
    containerBackend: "devcontainer",
    requestId: "req-1",
  });

  const response = emitted.find((m) => m.type === "container.probe.response");
  if (response?.type !== "container.probe.response") throw new Error("unreachable");
  expect(response.payload.success).toBe(false);
  expect(response.payload.error).toContain("container exploded");
  expect(response.payload.entries).toEqual([]);
});

// ---------------------------------------------------------------------------
// Real devcontainer + docker integration tests
// These tests actually run `devcontainer up` and `docker inspect`. They are
// skipped if Docker or the devcontainer CLI is not available.
// ---------------------------------------------------------------------------

/**
 * These tests need a daemon that can actually run the Linux images they use,
 * not merely a `docker` on PATH — Windows CI runners have the CLI, answer
 * `docker --version` happily, and then fail every `devcontainer up`. So the
 * question is whether a daemon answers at all, and the platform is one that
 * runs Linux containers natively. (`docker info --format {{.OSType}}` would be
 * the precise question, but podman's docker shim has no such field and would
 * take the whole suite down with it.)
 */
async function isDockerAvailable(): Promise<boolean> {
  if (isPlatform("win32")) {
    return false;
  }
  try {
    await execCommand("docker", ["info"], { envMode: "internal", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = await isDockerAvailable();
const dockerTest = dockerAvailable ? test : test.skip;

// Integration test: real docker ps + devcontainer CLI.
// Deterministic time control won't work — we're waiting for real subprocess
// I/O (docker ps, devcontainer up) against the platform clock.
dockerTest(
  "real backend: isAvailable + isAlreadyRunning + getConfigHash against real docker",
  async () => {
    const cwd = makeDevcontainerDir();
    const backend = createDevContainerBackend({ logger: createTestLogger() });

    // isAvailable checks devcontainer CLI + docker on PATH
    expect(await backend.isAvailable()).toBe(true);

    // isAlreadyRunning runs `docker ps --filter label=...` — no container for a fresh dir
    expect(
      await backend.isAlreadyRunning({ key: "real-test", kind: "workspace", workspaceFolder: cwd }),
    ).toBe(false);

    // getConfigHash hashes the devcontainer.json content
    const hash1 = backend.getConfigHash(cwd);
    expect(hash1).not.toBeNull();
    expect(hash1).toHaveLength(64); // SHA-256 hex

    // Modifying the config changes the hash
    writeFileSync(path.join(cwd, ".devcontainer.json"), '{"image":"alpine:latest","features":{}}');
    const hash2 = backend.getConfigHash(cwd);
    expect(hash2).not.toBeNull();
    expect(hash2).not.toBe(hash1);
  },
  15_000,
);

dockerTest(
  "real backend: container starts and containerStatus is running for devcontainer backend",
  async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "paseo-devcontainer-real-"));
    writeFileSync(path.join(cwd, ".devcontainer.json"), '{"image":"alpine:latest"}');
    const emitted: SessionOutboundMessage[] = [];
    const backend = createDevContainerBackend({ logger: createTestLogger() });

    expect(await backend.isAvailable()).toBe(true);

    const session = createContainerTestSession({
      backend,
      workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
      emitted,
    });

    const internals = asSessionInternals<{
      describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<{
        containerStatus?: string;
      }>;
    }>(session);

    const workspace = makeWorkspace({ cwd, containerBackend: "devcontainer" });
    // describeWorkspaceRecord is now non-blocking — it fires
    // maybeStartContainerForWorkspace as fire-and-forget. The descriptor
    // returns immediately with containerStatus "starting" (pending activation
    // registered). The container starts in the background.
    const descriptor = await internals.describeWorkspaceRecord(workspace);

    // containerStatus should be "starting" (pending activation registered)
    expect(descriptor.containerStatus).toBe("starting");

    // Wait for the container to actually start in the background. The
    // maybeStartContainerForWorkspace IIFE runs isAvailable, isAlreadyRunning,
    // then `devcontainer up`, which pulls alpine:latest and starts the
    // container. Container details are recorded at that point, so their
    // presence is the signal that the start finished.
    const { promise: containerReady, resolve: resolveContainerReady } =
      Promise.withResolvers<void>();
    const checkInterval = setInterval(() => {
      if (backend.getContainerInfo("ws-test")) {
        clearInterval(checkInterval);
        resolveContainerReady();
      }
    }, 1000);
    await containerReady;

    const info = backend.getContainerInfo("ws-test");
    expect(info).not.toBeNull();
    expect(info?.backend).toBe("devcontainer");
    expect(info?.image).toBeDefined();
    expect(info?.containerName).toBeDefined();

    await backend
      .stop({ key: "ws-test", kind: "workspace", workspaceFolder: cwd }, { remove: true })
      .catch(() => {});
  },
  120_000,
);

// ---------------------------------------------------------------------------
// Launch strategy resolution tests
// Verify that terminal and agent launch strategies are correctly resolved
// based on the workspace's containerBackend setting.
// ---------------------------------------------------------------------------

test("awaitStrategy returns isolated strategy after container starts for devcontainer workspace", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<unknown>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerBackend: "devcontainer" });
  await internals.describeWorkspaceRecord(workspace);
  await flushMicrotasks();

  // The launch strategy registry should now have an isolated strategy for this cwd.
  const registry = createLaunchStrategyRegistry({
    logger: createTestLogger(),
    createStrategy: (_key, workspaceFolder, handle) => dockerExecStrategy(handle, workspaceFolder),
  });
  // Register the same way maybeStartContainerForWorkspace does
  registry.registerPendingActivation("ws-test");
  registry.activateContainer("ws-test", cwd, HANDLE);
  const strategy = await registry.awaitStrategy("ws-test");
  expect(strategy.isIsolated).toBe(true);
});

test("awaitStrategy returns local strategy for host workspace", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: null })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<unknown>;
  }>(session);

  const workspace = makeWorkspace({ cwd, containerBackend: null });
  await internals.describeWorkspaceRecord(workspace);
  await flushMicrotasks();

  // No container was started, so awaitStrategy should return local strategy.
  const registry = createLaunchStrategyRegistry({
    logger: createTestLogger(),
    createStrategy: (_key, workspaceFolder, handle) => dockerExecStrategy(handle, workspaceFolder),
  });
  const strategy = await registry.awaitStrategy("ws-test");
  expect(strategy.isIsolated).toBe(false);
});

test("awaitStrategy throws when container fails to start (no fallback to host)", async () => {
  const registry = createLaunchStrategyRegistry({
    logger: createTestLogger(),
    createStrategy: (_key, workspaceFolder, handle) => dockerExecStrategy(handle, workspaceFolder),
  });

  // Register a pending activation, then deactivate while awaitStrategy is waiting.
  registry.registerPendingActivation("ws-test");

  // Start awaitStrategy (it will wait on the pending promise)
  const strategyPromise = registry.awaitStrategy("ws-test");

  // Deactivate (simulates container start failure) — this rejects the pending promise
  registry.deactivateContainer("ws-test");

  // awaitStrategy should throw, not fall back to local strategy
  await expect(strategyPromise).rejects.toThrow();
});

test("wrapCommand builds an interactive exec that runs in the container workspace", () => {
  const strategy = dockerExecStrategy(HANDLE, "/tmp/test-workspace");

  // Terminal creation: the resolved shell command with no args.
  const result = strategy.wrapCommand("/bin/zsh", [], {
    cwd: "/tmp/test-workspace",
    interactive: true,
  });

  expect(result.command).toBe("docker");
  expect(result.args).toContain("exec");
  // A terminal needs both halves of an interactive TTY.
  expect(result.args).toContain("-i");
  expect(result.args).toContain("-t");
  expect(result.args).toContain("-u");
  expect(result.args).toContain(HANDLE.remoteUser);
  expect(result.args).toContain(HANDLE.identifier);
  expect(result.args).toContain("-w");
  expect(result.args).toContain(HANDLE.remoteWorkspaceFolder);
  expect(result.args).toContain("/bin/zsh");
  // Everything after the container ID is the command, so every flag has to
  // come before it.
  const idIndex = result.args.indexOf(HANDLE.identifier);
  expect(result.args.indexOf("-w")).toBeLessThan(idIndex);
  expect(result.args.indexOf("-t")).toBeLessThan(idIndex);
  expect(idIndex).toBeLessThan(result.args.indexOf("/bin/zsh"));
});

test("wrapCommand keeps the command's own args and omits the TTY when not interactive", () => {
  const strategy = dockerExecStrategy(HANDLE, "/tmp/test-workspace");

  const result = strategy.wrapCommand("claude", ["--print", "hello"], {
    cwd: "/tmp/test-workspace",
  });

  expect(result.command).toBe("docker");
  expect(result.args).toContain("exec");
  // A piped process must not get a TTY, or its stdout stops being a pipe.
  expect(result.args).not.toContain("-t");
  expect(result.args.slice(result.args.indexOf(HANDLE.identifier) + 1)).toEqual([
    "claude",
    "--print",
    "hello",
  ]);
});

test("wrapCommand carries the terminal environment into the container", () => {
  const strategy = dockerExecStrategy(HANDLE, "/tmp/test-workspace");

  const result = strategy.wrapCommand("/bin/zsh", [], {
    cwd: "/tmp/test-workspace",
    env: { PASEO_TERMINAL_ID: "term-1", PASEO_ACTIVITY_TOKEN: "tok" },
    interactive: true,
  });

  const idIndex = result.args.indexOf(HANDLE.identifier);
  expect(result.args).toContain("PASEO_TERMINAL_ID=term-1");
  expect(result.args).toContain("PASEO_ACTIVITY_TOKEN=tok");
  expect(result.args.indexOf("PASEO_TERMINAL_ID=term-1")).toBeLessThan(idIndex);
});

test("wrapCommand maps a subdirectory of the workspace to its container path", () => {
  const strategy = dockerExecStrategy(HANDLE, "/tmp/test-workspace");

  const result = strategy.wrapCommand("/bin/zsh", [], { cwd: "/tmp/test-workspace/packages/app" });

  expect(result.args[result.args.indexOf("-w") + 1]).toBe("/workspaces/test/packages/app");
});

test("resolveCwd is idempotent for paths that are already container paths", () => {
  // Agents run inside the container, so the paths they hand back (an ACP
  // terminal's cwd, for instance) are container paths already.
  const strategy = dockerExecStrategy(HANDLE, "/tmp/test-workspace");

  expect(strategy.resolveCwd("/workspaces/test/src")).toBe("/workspaces/test/src");
  expect(strategy.resolveCwd("/tmp/test-workspace/src")).toBe("/workspaces/test/src");
  // Nothing outside the workspace is mounted; the workspace folder is the one
  // directory guaranteed to exist.
  expect(strategy.resolveCwd("/etc")).toBe("/workspaces/test");
});

test("container env forwards caller changes and unsets, not the daemon's own environment", () => {
  const daemonEnv = { PATH: "/host/bin", HOME: "/home/host", SHARED: "same", DROPPED: "gone" };

  const entries = resolveContainerEnvEntries(
    {
      // The base env the SDK hands us is the daemon's environment plus its own
      // additions, minus what it deliberately removed.
      env: { PATH: "/host/bin", HOME: "/home/host", SHARED: "same", ADDED: "yes" },
      envOverlay: { CLAUDECODE: undefined, PASEO_AGENT_ID: "agent-1" },
    },
    daemonEnv,
  );
  const asObject = Object.fromEntries(entries);

  expect(asObject).toHaveProperty("ADDED", "yes");
  expect(asObject).toHaveProperty("PASEO_AGENT_ID", "agent-1");
  // Explicitly unset in the container, so the image's own value cannot leak in.
  expect(entries).toContainEqual(["CLAUDECODE", undefined]);
  expect(entries).toContainEqual(["DROPPED", undefined]);
  // The image owns these, and an unchanged value carries no caller intent.
  expect(asObject).not.toHaveProperty("PATH");
  expect(asObject).not.toHaveProperty("HOME");
  expect(asObject).not.toHaveProperty("SHARED");
});

test("resolveDaemonUrl rewrites loopback to the container's host gateway", () => {
  const withGateway = new ContainerExecLaunchStrategy({
    command: "docker",
    leadingArgs: ["exec"],
    optionArgs: [],
    targetArgs: [HANDLE.identifier],
    workdirFlag: "-w",
    envFlag: "-e",
    ttyArgs: ["-t"],
    hostWorkspaceFolder: "/tmp/test-workspace",
    remoteWorkspaceFolder: HANDLE.remoteWorkspaceFolder,
    hostGatewayAddress: "172.17.0.1",
  });

  expect(withGateway.resolveDaemonUrl("http://127.0.0.1:6767/mcp/agents")).toBe(
    "http://172.17.0.1:6767/mcp/agents",
  );
  // A routable address is left alone.
  expect(withGateway.resolveDaemonUrl("http://10.0.0.5:6767/mcp/agents")).toBe(
    "http://10.0.0.5:6767/mcp/agents",
  );
  // Without a gateway the daemon is unreachable — callers drop the feature
  // rather than hand out an address that silently times out.
  expect(
    dockerExecStrategy(HANDLE, "/tmp/test-workspace").resolveDaemonUrl(
      "http://127.0.0.1:6767/mcp/agents",
    ),
  ).toBeNull();
});

test("the host strategy leaves the default shell to the terminal", async () => {
  await expect(new LocalLaunchStrategy().resolveDefaultShell()).resolves.toBeNull();
});

test("an unanswerable shell probe resolves to /bin/sh", async () => {
  // Every POSIX image has /bin/sh, so a container that cannot answer still
  // gets a launchable terminal instead of a host path it does not have.
  const strategy = new ContainerExecLaunchStrategy({
    command: "paseo-no-such-container-runtime",
    leadingArgs: ["exec"],
    optionArgs: [],
    targetArgs: [HANDLE.identifier],
    workdirFlag: "-w",
    envFlag: "-e",
    ttyArgs: ["-t"],
    hostWorkspaceFolder: "/tmp/test-workspace",
    remoteWorkspaceFolder: HANDLE.remoteWorkspaceFolder,
  });

  await expect(strategy.resolveDefaultShell()).resolves.toBe("/bin/sh");
});

test("a failed executable probe is not remembered as an answer", async () => {
  // A container still finishing its start answers nothing. Keeping that as the
  // verdict would report the agent missing for the container's whole life,
  // with a rebuild as the only way out.
  const runtimeDir = mkdtempSync(path.join(tmpdir(), "paseo-probe-runtime-"));
  const callLog = path.join(runtimeDir, "calls");
  // A node script rather than a shell one: this behaviour has nothing to do
  // with the platform, so the test should not either.
  const fakeRuntime = path.join(runtimeDir, "runtime.mjs");
  writeFileSync(
    fakeRuntime,
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(callLog)}, "call\\n");`,
      "process.exit(1);",
      "",
    ].join("\n"),
  );
  const strategy = new ContainerExecLaunchStrategy({
    command: process.execPath,
    leadingArgs: [fakeRuntime, "exec"],
    optionArgs: [],
    targetArgs: [HANDLE.identifier],
    workdirFlag: "-w",
    envFlag: "-e",
    ttyArgs: ["-t"],
    // The exec binary runs on the host, so this has to be a real directory.
    hostWorkspaceFolder: runtimeDir,
    remoteWorkspaceFolder: HANDLE.remoteWorkspaceFolder,
  });

  await expect(strategy.resolveExecutable("claude")).rejects.toThrow(/not on the container's PATH/);
  const afterFirst = readFileSync(callLog, "utf8").split("\n").length;
  await expect(strategy.resolveExecutable("claude")).rejects.toThrow(/not on the container's PATH/);

  expect(readFileSync(callLog, "utf8").split("\n").length).toBeGreaterThan(afterFirst);
});

test("a serialized strategy round-trips into an identical one", () => {
  // Terminals are created in a worker process, which can only receive data.
  const strategy = dockerExecStrategy(HANDLE, "/tmp/test-workspace");
  const restored = deserializeLaunchStrategy(strategy.serialize());

  expect(restored.isIsolated).toBe(true);
  expect(
    restored.wrapCommand("/bin/zsh", [], { cwd: "/tmp/test-workspace", interactive: true }),
  ).toEqual(
    strategy.wrapCommand("/bin/zsh", [], { cwd: "/tmp/test-workspace", interactive: true }),
  );
  expect(new LocalLaunchStrategy().serialize()).toBeNull();
  expect(deserializeLaunchStrategy(null).isIsolated).toBe(false);
});

test("resolveLaunchStrategy returns null for host workspace (agents run on host)", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: null })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<unknown>;
    launchStrategyRegistry: { hasContainerStrategy: (key: string) => boolean };
  }>(session);

  const workspace = makeWorkspace({ cwd, containerBackend: null });
  await internals.describeWorkspaceRecord(workspace);
  await flushMicrotasks();

  expect(internals.launchStrategyRegistry.hasContainerStrategy("ws-test")).toBe(false);
});

test("resolveLaunchStrategy returns isolated strategy for devcontainer workspace (agents run in container)", async () => {
  const cwd = makeDevcontainerDir();
  const emitted: SessionOutboundMessage[] = [];
  const backend = createMockContainerBackend({
    hasConfig: () => true,
    isAvailable: async () => true,
    isAlreadyRunning: async () => false,
  });

  const session = createContainerTestSession({
    backend,
    workspaces: [makeWorkspace({ cwd, containerBackend: "devcontainer" })],
    emitted,
  });

  const internals = asSessionInternals<{
    describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<unknown>;
    launchStrategyRegistry: { hasContainerStrategy: (key: string) => boolean };
  }>(session);

  const workspace = makeWorkspace({ cwd, containerBackend: "devcontainer" });
  await internals.describeWorkspaceRecord(workspace);
  await flushMicrotasks();

  // After the container starts, the launch strategy registry should have
  // an isolated strategy for this cwd.
  expect(internals.launchStrategyRegistry.hasContainerStrategy("ws-test")).toBe(true);
});

// ---------------------------------------------------------------------------
// Real docker: launch strategy integration tests
// These tests start a real container via `devcontainer up`, then verify the
// launch strategy chain end-to-end: awaitStrategy returns an isolated
// strategy, wrapCommand produces a valid docker exec, and the exec actually
// runs inside the container.
// ---------------------------------------------------------------------------

dockerTest(
  "real backend: awaitStrategy returns isolated strategy after container starts",
  async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "paseo-devcontainer-real-"));
    writeFileSync(path.join(cwd, ".devcontainer.json"), '{"image":"alpine:latest"}');
    const backend = createDevContainerBackend({ logger: createTestLogger() });

    expect(await backend.isAvailable()).toBe(true);

    // Start the container directly
    const handle = await backend.up({
      key: "real-launch-1",
      kind: "workspace",
      workspaceFolder: cwd,
    });
    expect(handle.identifier).toBeDefined();
    expect(handle.remoteUser).toBeDefined();
    expect(handle.remoteWorkspaceFolder).toBeDefined();

    // Create a launch strategy registry with the real handle
    const registry = createLaunchStrategyRegistry({
      logger: createTestLogger(),
      createStrategy: backend.createStrategy,
    });
    registry.activateContainer("real-launch-1", cwd, handle);

    const strategy = await registry.awaitStrategy("real-launch-1");
    expect(strategy.isIsolated).toBe(true);

    await backend
      .stop({ key: "real-launch-1", kind: "workspace", workspaceFolder: cwd })
      .catch(() => {});
  },
  120_000,
);

dockerTest(
  "real backend: spawn runs command inside the container (verifies agent exec path)",
  async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "paseo-devcontainer-real-"));
    writeFileSync(path.join(cwd, ".devcontainer.json"), '{"image":"alpine:latest"}');
    const backend = createDevContainerBackend({ logger: createTestLogger() });

    expect(await backend.isAvailable()).toBe(true);

    const handle = await backend.up({
      key: "real-launch-2",
      kind: "workspace",
      workspaceFolder: cwd,
    });

    const strategy = backend.createStrategy("real-launch-2", cwd, handle);

    // spawn is used for agents (non-interactive). It does NOT add -it.
    // Verify the command actually runs inside the container, and that the
    // launch environment lands with the process rather than on the host-side
    // exec call.
    const child = strategy.spawn("sh", ["-c", 'echo "agent-in-container $AGENT_TOKEN"'], {
      cwd,
      envOverlay: { AGENT_TOKEN: "from-launch-env" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const { promise, resolve } = Promise.withResolvers<string>();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("close", () => {
      resolve(stdout.trim() || stderr.trim());
    });
    const output = await promise;

    expect(output).toBe("agent-in-container from-launch-env");

    await backend
      .stop({ key: "real-launch-2", kind: "workspace", workspaceFolder: cwd })
      .catch(() => {});
  },
  120_000,
);

dockerTest(
  "real backend: a probe builds a usable container, streams progress, and removes it",
  async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "paseo-devcontainer-real-"));
    writeFileSync(path.join(cwd, ".devcontainer.json"), '{"image":"alpine:latest"}');
    const backend = createDevContainerBackend({ logger: createTestLogger() });
    const progressLines: string[] = [];
    let commandOutputInsideProbe = "";

    const coordinator = new ContainerProbeCoordinator({
      logger: createTestLogger(),
      resolveBackend: () => backend,
      probeProviders: async ({ launchStrategy }) => {
        // Providers are listed by running them inside the probe container, so
        // the container has to be alive and exec-able at exactly this point.
        const child = launchStrategy.spawn("sh", ["-c", "echo probe-ran"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        const { promise, resolve } = Promise.withResolvers<void>();
        child.stdout?.on("data", (data: Buffer) => {
          commandOutputInsideProbe += data.toString();
        });
        child.on("close", () => resolve());
        await promise;
        return [{ provider: "claude" as const, status: "ready" as const, enabled: true }];
      },
    });

    const result = await coordinator.probe({
      requestId: "real-probe-1",
      cwd,
      containerBackend: "devcontainer",
      onProgress: (line) => progressLines.push(line),
    });

    expect(result.status).toBe("success");
    expect(result.entries).toHaveLength(1);
    expect(commandOutputInsideProbe.trim()).toBe("probe-ran");
    // Progress arrives while the CLI runs, not replayed after it finishes.
    expect(progressLines.length).toBeGreaterThan(0);

    // Nothing of the probe survives it.
    const leftovers = await execCommand(
      "docker",
      [
        "ps",
        "-aq",
        "--filter",
        "label=paseo.owner=probe",
        "--filter",
        `label=devcontainer.local_folder=${cwd}`,
      ],
      { envMode: "internal", timeout: 10_000 },
    );
    expect(leftovers.stdout.trim()).toBe("");
  },
  180_000,
);

dockerTest(
  "real backend: workspaces and probes on one directory each get their own container",
  async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "paseo-devcontainer-real-"));
    writeFileSync(path.join(cwd, ".devcontainer.json"), '{"image":"alpine:latest"}');
    const backend = createDevContainerBackend({ logger: createTestLogger() });
    // Two workspaces can share a directory, and a probe can run against a
    // directory a workspace already occupies. All three are the same folder and
    // the same devcontainer.json — only the key differs.
    const firstRef = { key: "ws-identity-a", kind: "workspace" as const, workspaceFolder: cwd };
    const secondRef = { key: "ws-identity-b", kind: "workspace" as const, workspaceFolder: cwd };
    const probeRef = { key: "probe:identity-test", kind: "probe" as const, workspaceFolder: cwd };

    expect(await backend.isAvailable()).toBe(true);

    try {
      const firstHandle = await backend.up(firstRef);
      const secondHandle = await backend.up(secondRef);
      const probeHandle = await backend.up(probeRef);

      // The devcontainer CLI identifies containers by workspace folder unless
      // it is given id labels, so without them these would be one container —
      // and tearing any of them down would stop the others' agents.
      const identifiers = new Set([
        firstHandle.identifier,
        secondHandle.identifier,
        probeHandle.identifier,
      ]);
      expect(identifiers.size).toBe(3);

      await backend.stop(probeRef, { remove: true });

      expect(await backend.isAlreadyRunning(probeRef)).toBe(false);
      expect(await backend.isAlreadyRunning(firstRef)).toBe(true);
      expect(await backend.isAlreadyRunning(secondRef)).toBe(true);

      // Stopping one workspace's container leaves the other's alone.
      await backend.stop(firstRef, { remove: true });

      expect(await backend.isAlreadyRunning(firstRef)).toBe(false);
      expect(await backend.isAlreadyRunning(secondRef)).toBe(true);
      expect(backend.getContainerInfo("ws-identity-b")).not.toBeNull();
    } finally {
      for (const ref of [firstRef, secondRef, probeRef]) {
        await backend.stop(ref, { remove: true }).catch(() => {});
      }
    }
  },
  240_000,
);

dockerTest(
  "real backend: probe containers left by a previous run are reaped, workspace ones are not",
  async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "paseo-devcontainer-real-"));
    writeFileSync(path.join(cwd, ".devcontainer.json"), '{"image":"alpine:latest"}');
    const backend = createDevContainerBackend({ logger: createTestLogger() });
    const workspaceRef = { key: "ws-reap-test", kind: "workspace" as const, workspaceFolder: cwd };
    const probeRef = { key: "probe:reap-test", kind: "probe" as const, workspaceFolder: cwd };

    expect(await backend.isAvailable()).toBe(true);

    try {
      await backend.up(workspaceRef);
      await backend.up(probeRef);

      // Stands in for a daemon that died mid-probe: the container is still
      // there, and a fresh daemon has no handle for it.
      const removed = await backend.removeAbandonedProbeContainers();

      expect(removed).toBeGreaterThanOrEqual(1);
      expect(await backend.isAlreadyRunning(probeRef)).toBe(false);
      expect(await backend.isAlreadyRunning(workspaceRef)).toBe(true);
    } finally {
      await backend.stop(workspaceRef, { remove: true }).catch(() => {});
      await backend.stop(probeRef, { remove: true }).catch(() => {});
    }
  },
  180_000,
);

dockerTest(
  "real backend: transcripts are read from inside the container, not the host",
  async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "paseo-devcontainer-real-"));
    writeFileSync(path.join(cwd, ".devcontainer.json"), '{"image":"alpine:latest"}');
    const backend = createDevContainerBackend({ logger: createTestLogger() });
    const ref = { key: "real-transcripts", kind: "workspace" as const, workspaceFolder: cwd };

    expect(await backend.isAvailable()).toBe(true);

    try {
      const handle = await backend.up(ref);
      const strategy = backend.createStrategy(ref.key, cwd, handle);
      const files = createLaunchFileSystem(strategy);

      // An agent writes its transcripts under the container's HOME, keyed by
      // the container's cwd — neither of which exists on the host.
      const home = await files.homeDir();
      expect(home.startsWith("/")).toBe(true);
      const sessionDir = `${home}/.claude/projects/-workspaces-demo`;
      const transcript = `${sessionDir}/session-1.jsonl`;
      const write = strategy.spawn("sh", [
        "-c",
        `mkdir -p ${sessionDir} && printf 'head-line\nlast-line\n' > ${transcript}`,
      ]);
      await new Promise((resolve) => write.on("close", resolve));

      const listed = await files.listFiles(`${home}/.claude/projects`, {
        suffix: ".jsonl",
        maxDepth: 2,
      });
      expect(listed.map((entry) => entry.path)).toEqual([transcript]);
      expect(listed[0].mtimeMs).toBeGreaterThan(0);
      expect(listed[0].size).toBe(20);

      expect(await files.readFile(transcript)).toBe("head-line\nlast-line\n");
      expect(await files.readHead(transcript, 9)).toBe("head-line");
      expect(await files.readTail(transcript, 10)).toBe("last-line\n");
      expect(await files.exists(transcript)).toBe(true);

      // The host must not have gained any of this.
      const hostFiles = createLaunchFileSystem(null);
      expect(await hostFiles.exists(transcript)).toBe(false);

      // A provider configured through files needs them on the container's
      // disk; the daemon's own /tmp is not mounted there.
      const configDir = await files.makeTempDir("paseo-pi-mcp-");
      const configPath = `${configDir}/mcp.json`;
      await files.writeFile(configPath, '{"mcpServers":{}}');
      expect(await files.readFile(configPath)).toBe('{"mcpServers":{}}');
      expect(await hostFiles.exists(configPath)).toBe(false);

      await files.remove(configDir);
      expect(await files.exists(configPath)).toBe(false);

      await files.remove(transcript);
      expect(await files.exists(transcript)).toBe(false);
    } finally {
      await backend.stop(ref, { remove: true }).catch(() => {});
    }
  },
  180_000,
);

dockerTest(
  "real backend: Claude lists the container's sessions, not the host's",
  async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "paseo-devcontainer-real-"));
    writeFileSync(path.join(cwd, ".devcontainer.json"), '{"image":"alpine:latest"}');
    const backend = createDevContainerBackend({ logger: createTestLogger() });
    const ref = { key: "real-claude-import", kind: "workspace" as const, workspaceFolder: cwd };

    expect(await backend.isAvailable()).toBe(true);

    try {
      const handle = await backend.up(ref);
      const strategy = backend.createStrategy(ref.key, cwd, handle);
      const files = createLaunchFileSystem(strategy);
      const home = await files.homeDir();

      // Claude names the directory after the cwd it ran in, which inside the
      // container is the remote workspace folder.
      const encoded = handle.remoteWorkspaceFolder.replaceAll("/", "-");
      const sessionDir = `${home}/.claude/projects/${encoded}`;
      const transcript = `${sessionDir}/11111111-2222-3333-4444-555555555555.jsonl`;
      const record = JSON.stringify({
        type: "user",
        sessionId: "11111111-2222-3333-4444-555555555555",
        cwd: handle.remoteWorkspaceFolder,
        message: { role: "user", content: "hello from inside the container" },
      });
      const write = strategy.spawn("sh", [
        "-c",
        `mkdir -p ${sessionDir} && printf '%s\n' ${JSON.stringify(record)} > ${transcript}`,
      ]);
      await new Promise((resolve) => write.on("close", resolve));

      const client = new ClaudeAgentClient({
        logger: createTestLogger(),
        resolveBinary: async () => "claude",
      });
      const sessions = await client.listImportableSessions({ cwd, launchStrategy: strategy });

      expect(sessions.map((session) => session.providerHandleId)).toEqual([
        "11111111-2222-3333-4444-555555555555",
      ]);
      // The cwd comes out of the transcript, so it is the container's.
      expect(sessions[0].cwd).toBe(handle.remoteWorkspaceFolder);
      expect(sessions[0].firstPromptPreview).toBe("hello from inside the container");

      // The same call without a container must not see it.
      expect(await client.listImportableSessions({ cwd })).toEqual([]);
    } finally {
      await backend.stop(ref, { remove: true }).catch(() => {});
    }
  },
  180_000,
);

dockerTest(
  "real backend: a missing agent is named, not left to fail as exit 127",
  async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "paseo-devcontainer-real-"));
    writeFileSync(path.join(cwd, ".devcontainer.json"), '{"image":"alpine:latest"}');
    const backend = createDevContainerBackend({ logger: createTestLogger() });
    const ref = { key: "real-exec", kind: "workspace" as const, workspaceFolder: cwd };

    expect(await backend.isAvailable()).toBe(true);

    try {
      const handle = await backend.up(ref);
      const strategy = backend.createStrategy(ref.key, cwd, handle);

      // An agent has to be on the container's PATH, however it got there, and
      // the answer is where it is — the launch then needs no PATH at all.
      expect(await strategy.resolveExecutable("sh")).toMatch(/^\/.*\/sh$/);
      // Without this check the launch reaches the container runtime and comes
      // back as "exited with code 127", which says nothing about what to do.
      await expect(strategy.resolveExecutable("claude")).rejects.toThrow(
        /'claude' is not on the container's PATH/,
      );
    } finally {
      await backend.stop(ref, { remove: true }).catch(() => {});
    }
  },
  180_000,
);

dockerTest(
  "real backend: an agent on PATH only through the shell's startup files is found",
  async () => {
    // The reported case: `claude` runs fine in a container terminal but the
    // launch says it is not on the PATH. `docker exec` starts a bare process
    // with only the image's PATH; the terminal runs a shell, which adds what
    // the user's startup files put there — ~/.local/bin, nvm, and so on.
    const cwd = mkdtempSync(path.join(tmpdir(), "paseo-devcontainer-real-"));
    writeFileSync(path.join(cwd, ".devcontainer.json"), '{"image":"alpine:latest"}');
    const backend = createDevContainerBackend({ logger: createTestLogger() });
    const ref = { key: "real-shell-path", kind: "workspace" as const, workspaceFolder: cwd };

    expect(await backend.isAvailable()).toBe(true);

    try {
      const handle = await backend.up(ref);
      const strategy = backend.createStrategy(ref.key, cwd, handle);

      // An agent somewhere the image's PATH does not mention, plus a startup
      // file that puts it there — exactly how a per-user install looks.
      const install = strategy.spawn("sh", [
        "-c",
        [
          "mkdir -p /opt/agent-bin /etc/profile.d",
          "printf '#!/bin/sh\\necho ran-in-container\\n' > /opt/agent-bin/fakeagent",
          "chmod +x /opt/agent-bin/fakeagent",
          "printf 'export PATH=/opt/agent-bin:$PATH\\n' > /etc/profile.d/agent-path.sh",
        ].join(" && "),
      ]);
      await new Promise((resolve) => install.on("close", resolve));

      // A bare exec cannot see it — this is the state that produced the bug.
      const bare = strategy.spawn("sh", ["-c", "command -v fakeagent"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      const [bareCode] = (await once(bare, "close")) as [number | null];
      expect(bareCode).not.toBe(0);

      // Asking the environment's own shell finds it, and answers with a path
      // that needs no PATH to launch.
      const resolved = await strategy.resolveExecutable("fakeagent");
      expect(resolved).toBe("/opt/agent-bin/fakeagent");

      const child = strategy.spawn(resolved, [], { stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      const [code] = (await once(child, "close")) as [number | null];
      expect(code).toBe(0);
      expect(output.trim()).toBe("ran-in-container");
    } finally {
      await backend.stop(ref, { remove: true }).catch(() => {});
    }
  },
  180_000,
);

dockerTest(
  "real backend: the terminal shell comes from the container's own user, not the host",
  async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "paseo-devcontainer-real-"));
    // /bin/ash is a real alpine shell and is not the /bin/sh fallback, so the
    // assertion can only pass if the probe actually read the container.
    writeFileSync(
      path.join(cwd, ".devcontainer.json"),
      '{"image":"alpine:latest","containerEnv":{"SHELL":"/bin/ash"}}',
    );
    const backend = createDevContainerBackend({ logger: createTestLogger() });

    expect(await backend.isAvailable()).toBe(true);

    const handle = await backend.up({ key: "real-shell", kind: "workspace", workspaceFolder: cwd });
    const strategy = backend.createStrategy("real-shell", cwd, handle);

    expect(await strategy.resolveDefaultShell()).toBe("/bin/ash");

    await backend
      .stop({ key: "real-shell", kind: "workspace", workspaceFolder: cwd })
      .catch(() => {});
  },
  120_000,
);

dockerTest(
  "real backend: full session flow — describeWorkspaceRecord starts container and registry has isolated strategy",
  async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "paseo-devcontainer-real-"));
    writeFileSync(path.join(cwd, ".devcontainer.json"), '{"image":"alpine:latest"}');
    const emitted: SessionOutboundMessage[] = [];
    const backend = createDevContainerBackend({ logger: createTestLogger() });

    expect(await backend.isAvailable()).toBe(true);

    const session = createContainerTestSession({
      backend,
      workspaces: [
        makeWorkspace({ workspaceId: "ws-full-flow", cwd, containerBackend: "devcontainer" }),
      ],
      emitted,
    });

    const internals = asSessionInternals<{
      describeWorkspaceRecord: (workspace: PersistedWorkspaceRecord) => Promise<{
        containerStatus?: string;
      }>;
      launchStrategyRegistry: {
        hasContainerStrategy: (key: string) => boolean;
        awaitStrategy: (key: string) => Promise<{ isIsolated: boolean }>;
      };
    }>(session);

    const workspace = makeWorkspace({
      workspaceId: "ws-full-flow",
      cwd,
      containerBackend: "devcontainer",
    });
    const descriptor = await internals.describeWorkspaceRecord(workspace);

    // containerStatus should be "starting" (pending activation registered synchronously)
    expect(descriptor.containerStatus).toBe("starting");

    // Wait for the background start to finish. Poll the registry rather than
    // the container runtime: `docker ps` sees the container before `up` returns
    // and the strategy is activated.
    const { promise: containerReady, resolve: resolveContainerReady } =
      Promise.withResolvers<void>();
    const checkInterval = setInterval(() => {
      if (internals.launchStrategyRegistry.hasContainerStrategy("ws-full-flow")) {
        clearInterval(checkInterval);
        resolveContainerReady();
      }
    }, 500);
    await containerReady;

    const strategy = await internals.launchStrategyRegistry.awaitStrategy("ws-full-flow");
    expect(strategy.isIsolated).toBe(true);

    await backend
      .stop({ key: "ws-full-flow", kind: "workspace", workspaceFolder: cwd }, { remove: true })
      .catch(() => {});
  },
  120_000,
);
