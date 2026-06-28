import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { afterEach, describe, expect, test } from "vitest";
import type { SessionOutboundMessage, StartWorkspaceScriptRequest } from "../../messages.js";
import { createServiceProxySubsystem, type ServiceProxySubsystem } from "../../service-proxy.js";
import type { TerminalManager } from "../../../terminal/terminal-manager.js";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "../../workspace-registry.js";
import type { WorkspaceGitMetadata } from "../../workspace-git-metadata.js";
import { WorkspaceScriptRuntimeStore } from "../../workspace-script-runtime-store.js";
import type {
  SpawnWorkspaceScriptOptions,
  WorktreeScriptResult,
} from "../../worktree-bootstrap.js";
import { createWorkspaceScriptsService } from "./workspace-scripts-service.js";

// The production module reads only WorkspaceGitService.{peekSnapshot,getWorkspaceGitMetadata},
// WorkspaceRegistry.get, and forwards the launcher + opaque managers to the injected
// spawnWorkspaceScript port. The fakes below implement exactly that slice; the service proxy and
// runtime store are the real in-memory implementations, and spawning is injected so no process runs.

const logger = pino({ level: "silent" });

const gitMetadata: WorkspaceGitMetadata = {
  projectKind: "git",
  projectDisplayName: "repo",
  workspaceDisplayName: "repo",
  gitRemote: null,
  isWorktree: false,
  projectSlug: "paseo",
  repoRoot: "/tmp/repo",
  currentBranch: "feature/scripts",
  remoteUrl: null,
};

function fakeWorkspaceRegistry(
  record: PersistedWorkspaceRecord | null,
): Pick<WorkspaceRegistry, "get"> {
  return {
    async get() {
      return record;
    },
  };
}

function fakeGitService(metadata: WorkspaceGitMetadata = gitMetadata) {
  return {
    peekSnapshot() {
      return null;
    },
    async getWorkspaceGitMetadata() {
      return metadata;
    },
  };
}

// The service only truthiness-checks terminalManager in its availability guard and then forwards it
// opaquely to the injected spawnWorkspaceScript fake, which ignores it — an empty stand-in is enough.
const availableTerminalManager = {} as unknown as TerminalManager;

interface BuildOptions {
  serviceProxy?: ServiceProxySubsystem | null;
  scriptRuntimeStore?: WorkspaceScriptRuntimeStore | null;
  terminalManager?: TerminalManager | null;
  workspace?: PersistedWorkspaceRecord | null;
  spawnThrows?: string;
}

function buildService(options: BuildOptions = {}) {
  const emitted: SessionOutboundMessage[] = [];
  const spawnCalls: SpawnWorkspaceScriptOptions[] = [];
  const workspace =
    options.workspace === undefined
      ? ({ workspaceId: "ws-1", cwd: "/tmp/repo" } as PersistedWorkspaceRecord)
      : options.workspace;

  const service = createWorkspaceScriptsService({
    serviceProxy:
      options.serviceProxy === undefined
        ? createServiceProxySubsystem({ logger })
        : options.serviceProxy,
    scriptRuntimeStore:
      options.scriptRuntimeStore === undefined
        ? new WorkspaceScriptRuntimeStore()
        : options.scriptRuntimeStore,
    terminalManager:
      options.terminalManager === undefined ? availableTerminalManager : options.terminalManager,
    workspaceRegistry: fakeWorkspaceRegistry(workspace),
    workspaceGitService: fakeGitService(),
    getDaemonTcpPort: () => 6767,
    getDaemonTcpHost: () => "127.0.0.1",
    serviceProxyPublicBaseUrl: null,
    resolveScriptHealth: null,
    logger,
    emit: (message) => emitted.push(message),
    async spawnWorkspaceScript(spawnOptions): Promise<WorktreeScriptResult> {
      spawnCalls.push(spawnOptions);
      if (options.spawnThrows) {
        throw new Error(options.spawnThrows);
      }
      spawnOptions.onLifecycleChanged?.();
      return {
        scriptName: spawnOptions.scriptName,
        hostname: null,
        port: null,
        terminalId: "terminal-1",
      };
    },
  });

  return { service, emitted, spawnCalls };
}

const request: StartWorkspaceScriptRequest = {
  type: "start_workspace_script_request",
  workspaceId: "ws-1",
  scriptName: "app",
  requestId: "req-1",
};

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("buildSnapshot", () => {
  test("returns no scripts when the service proxy is unavailable", () => {
    const { service } = buildService({ serviceProxy: null });
    expect(service.buildSnapshot("ws-1", "/tmp/repo")).toEqual([]);
  });

  test("returns no scripts when the runtime store is unavailable", () => {
    const { service } = buildService({ scriptRuntimeStore: null });
    expect(service.buildSnapshot("ws-1", "/tmp/repo")).toEqual([]);
  });

  test("returns no scripts for a workspace without a paseo.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "workspace-scripts-"));
    tempDirs.push(dir);
    const { service } = buildService();
    expect(service.buildSnapshot("ws-1", dir)).toEqual([]);
  });
});

describe("emitStatusUpdate", () => {
  test("emits one script_status_update carrying the snapshot", () => {
    const { service, emitted } = buildService();
    service.emitStatusUpdate("ws-1", "/tmp/repo");
    expect(emitted).toEqual([
      { type: "script_status_update", payload: { workspaceId: "ws-1", scripts: [] } },
    ]);
  });
});

describe("start", () => {
  test("reports an error when workspace scripts are unavailable", async () => {
    const { service, emitted, spawnCalls } = buildService({ terminalManager: null });
    await service.start(request);
    expect(spawnCalls).toEqual([]);
    expect(emitted).toEqual([
      {
        type: "start_workspace_script_response",
        payload: {
          requestId: "req-1",
          workspaceId: "ws-1",
          scriptName: "app",
          terminalId: null,
          error: "Workspace scripts are not available on this daemon",
        },
      },
    ]);
  });

  test("reports an error when the workspace is not found", async () => {
    const { service, emitted, spawnCalls } = buildService({ workspace: null });
    await service.start(request);
    expect(spawnCalls).toEqual([]);
    expect(emitted).toEqual([
      {
        type: "start_workspace_script_response",
        payload: {
          requestId: "req-1",
          workspaceId: "ws-1",
          scriptName: "app",
          terminalId: null,
          error: "Workspace not found: ws-1",
        },
      },
    ]);
  });

  test("spawns the script with resolved git metadata and reports success", async () => {
    const { service, emitted, spawnCalls } = buildService();
    await service.start(request);

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({
      repoRoot: "/tmp/repo",
      workspaceId: "ws-1",
      projectSlug: "paseo",
      branchName: "feature/scripts",
      scriptName: "app",
      daemonPort: 6767,
      daemonListenHost: "127.0.0.1",
    });
    expect(emitted).toContainEqual({
      type: "script_status_update",
      payload: { workspaceId: "ws-1", scripts: [] },
    });
    expect(emitted).toContainEqual({
      type: "start_workspace_script_response",
      payload: {
        requestId: "req-1",
        workspaceId: "ws-1",
        scriptName: "app",
        terminalId: "terminal-1",
        error: null,
      },
    });
  });

  test("reports the launcher error when spawning fails", async () => {
    const { service, emitted } = buildService({ spawnThrows: "boom" });
    await service.start(request);
    expect(emitted).toEqual([
      {
        type: "start_workspace_script_response",
        payload: {
          requestId: "req-1",
          workspaceId: "ws-1",
          scriptName: "app",
          terminalId: null,
          error: "boom",
        },
      },
    ]);
  });
});
