import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import type { AgentTimelineItem } from "./agent/agent-sdk-types.js";
import { runAsyncWorktreeBootstrap, spawnWorkspaceScript } from "./worktree-bootstrap.js";
import { ensureWorkspaceServicePortPlan } from "./workspace-service-port-registry.js";
import { ScriptRouteStore } from "./script-proxy.js";
import { createBranchChangeRouteHandler } from "./script-route-branch-handler.js";
import { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import {
  createWorktree as createWorktreePrimitive,
  type WorktreeConfig,
} from "../utils/worktree.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type { TerminalSession } from "../terminal/terminal.js";

interface CreateAgentWorktreeTestOptions {
  cwd: string;
  branchName: string;
  baseBranch: string;
  worktreeSlug: string;
  paseoHome?: string;
}

interface CreateAgentWorktreeTestResult {
  worktree: WorktreeConfig;
  shouldBootstrap: boolean;
}

async function cleanupTerminalManager(terminalManager: TerminalManager): Promise<void> {
  const terminalsByCwd = await Promise.all(
    terminalManager.listDirectories().map((cwd) => terminalManager.getTerminals(cwd)),
  );
  const terminals = terminalsByCwd.flat();
  await Promise.all(terminals.map((terminal) => killTerminal(terminalManager, terminal)));
  terminalManager.killAll();
}

function killTerminal(terminalManager: TerminalManager, terminal: TerminalSession): Promise<void> {
  return terminalManager.killTerminalAndWait(terminal.id, {
    gracefulTimeoutMs: 100,
    forceTimeoutMs: 100,
  });
}

async function createBootstrapWorktreeForTest(
  options: CreateAgentWorktreeTestOptions,
): Promise<CreateAgentWorktreeTestResult> {
  const worktree = await createWorktreePrimitive({
    cwd: options.cwd,
    worktreeSlug: options.worktreeSlug,
    source: {
      kind: "branch-off",
      baseBranch: options.baseBranch,
      branchName: options.branchName,
    },
    runSetup: false,
    paseoHome: options.paseoHome,
  });
  return { worktree, shouldBootstrap: true };
}

describe("runAsyncWorktreeBootstrap", () => {
  let tempDir: string;
  let repoDir: string;
  let paseoHome: string;
  let realTerminalManagers: TerminalManager[];

  beforeEach(() => {
    realTerminalManagers = [];
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-bootstrap-test-")));
    repoDir = join(tempDir, "repo");
    paseoHome = join(tempDir, "paseo-home");

    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "file.txt"), "hello\n");
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
      cwd: repoDir,
      stdio: "pipe",
    });
  });

  afterEach(async () => {
    await Promise.all(realTerminalManagers.map(cleanupTerminalManager));
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not fail setup when live timeline emission throws", async () => {
    writeFileSync(
      join(repoDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          setup: ['echo "ok"'],
        },
      }),
    );
    execFileSync("git", ["add", "paseo.json"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add setup"], {
      cwd: repoDir,
      stdio: "pipe",
    });

    const worktreeBootstrap = await createBootstrapWorktreeForTest({
      cwd: repoDir,
      branchName: "feature-live-failure",
      baseBranch: "main",
      worktreeSlug: "feature-live-failure",
      paseoHome,
    });

    const persisted: AgentTimelineItem[] = [];
    await expect(
      runAsyncWorktreeBootstrap({
        agentId: "agent-live-failure",
        worktree: worktreeBootstrap.worktree,
        shouldBootstrap: worktreeBootstrap.shouldBootstrap,
        terminalManager: null,
        appendTimelineItem: async (item) => {
          persisted.push(item);
          return true;
        },
        emitLiveTimelineItem: async () => {
          throw new Error("live emit failed");
        },
      }),
    ).resolves.toBeUndefined();

    const persistedSetupItems = persisted.filter(
      (item) => item.type === "tool_call" && item.name === "paseo_worktree_setup",
    );
    expect(persistedSetupItems).toHaveLength(1);
    if (persistedSetupItems[0]?.type === "tool_call") {
      expect(persistedSetupItems[0].status).toBe("completed");
    }
  });

  it("truncates each command output to 64kb in the middle", async () => {
    const largeOutputCommand =
      "node -e \"process.stdout.write('prefix-'); process.stdout.write('x'.repeat(70000)); process.stdout.write('-suffix')\"";
    writeFileSync(
      join(repoDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          setup: [largeOutputCommand],
        },
      }),
    );
    execFileSync("git", ["add", "paseo.json"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add large output setup"], {
      cwd: repoDir,
      stdio: "pipe",
    });

    const worktreeBootstrap = await createBootstrapWorktreeForTest({
      cwd: repoDir,
      branchName: "feature-large-output",
      baseBranch: "main",
      worktreeSlug: "feature-large-output",
      paseoHome,
    });

    const persisted: AgentTimelineItem[] = [];
    await runAsyncWorktreeBootstrap({
      agentId: "agent-large-output",
      worktree: worktreeBootstrap.worktree,
      shouldBootstrap: worktreeBootstrap.shouldBootstrap,
      terminalManager: null,
      appendTimelineItem: async (item) => {
        persisted.push(item);
        return true;
      },
      emitLiveTimelineItem: async () => true,
    });

    const persistedSetupItem = persisted.find(
      (item): item is Extract<AgentTimelineItem, { type: "tool_call" }> =>
        item.type === "tool_call" && item.name === "paseo_worktree_setup",
    );
    expect(persistedSetupItem).toBeDefined();
    expect(persistedSetupItem?.detail.type).toBe("worktree_setup");
    if (!persistedSetupItem || persistedSetupItem.detail.type !== "worktree_setup") {
      throw new Error("Expected worktree_setup tool detail");
    }

    expect(persistedSetupItem.detail.truncated).toBe(true);
    expect(persistedSetupItem.detail.log).toContain("prefix-");
    expect(persistedSetupItem.detail.log).toContain("-suffix");
    expect(persistedSetupItem.detail.log).toContain("...<output truncated in the middle>...");
    expect(persistedSetupItem.detail.commands[0]?.log).toContain("prefix-");
    expect(persistedSetupItem.detail.commands[0]?.log).toContain("-suffix");
    expect(persistedSetupItem.detail.commands[0]?.log).toContain(
      "...<output truncated in the middle>...",
    );
  });

  it("waits for terminal output before sending bootstrap commands", async () => {
    writeFileSync(
      join(repoDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          terminals: [
            {
              name: "Ready Terminal",
              command: "echo ready",
            },
          ],
        },
      }),
    );
    execFileSync("git", ["add", "paseo.json"], { cwd: repoDir, stdio: "pipe" });
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "commit", "-m", "add terminal bootstrap config"],
      {
        cwd: repoDir,
        stdio: "pipe",
      },
    );

    const worktreeBootstrap = await createBootstrapWorktreeForTest({
      cwd: repoDir,
      branchName: "feature-terminal-readiness",
      baseBranch: "main",
      worktreeSlug: "feature-terminal-readiness",
      paseoHome,
    });

    let readyAt = 0;
    let sendAt = 0;
    let outputListener: ((chunk: { data: string }) => void) | null = null;

    await runAsyncWorktreeBootstrap({
      agentId: "agent-terminal-readiness",
      worktree: worktreeBootstrap.worktree,
      shouldBootstrap: worktreeBootstrap.shouldBootstrap,
      terminalManager: {
        async getTerminals() {
          return [];
        },
        async createTerminal(options) {
          setTimeout(() => {
            readyAt = Date.now();
            outputListener?.({ data: "$ " });
          }, 25);
          return {
            id: "term-ready",
            name: options.name ?? "Terminal",
            cwd: options.cwd,
            send: () => {
              sendAt = Date.now();
            },
            subscribe: (listener) => {
              outputListener = (chunk) => listener({ type: "output", data: chunk.data });
              return () => {
                outputListener = null;
              };
            },
            onExit: () => () => {},
            onCommandFinished: () => () => {},
            onTitleChange: () => () => {},
            getSize: () => ({ rows: 0, cols: 0 }),
            getTitle: () => undefined,
            getExitInfo: () => null,
            getState: () => ({
              rows: 0,
              cols: 0,
              grid: [],
              scrollback: [],
              cursor: { row: 0, col: 0 },
            }),
            kill: () => {},
            killAndWait: async () => {},
          };
        },
        registerCwdEnv() {},
        getTerminal() {
          return undefined;
        },
        killTerminal() {},
        async killTerminalAndWait() {},
        listDirectories() {
          return [];
        },
        killAll() {},
        subscribeTerminalsChanged() {
          return () => {};
        },
      },
      appendTimelineItem: async () => true,
      emitLiveTimelineItem: async () => true,
    });

    expect(readyAt).toBeGreaterThan(0);
    expect(sendAt).toBeGreaterThan(0);
    expect(sendAt).toBeGreaterThanOrEqual(readyAt);
  });

  interface CreateTerminalCall {
    cwd: string;
    name?: string;
    title?: string;
    env?: Record<string, string>;
  }

  interface StubTerminalRecord {
    id: string;
    triggerExit: (exitCode: number) => void;
    triggerCommandFinished: (exitCode: number) => void;
    sentInputs: string[];
  }

  function createStubTerminalManager(
    createTerminalCalls: CreateTerminalCall[],
    terminalRecords: StubTerminalRecord[] = [],
  ): TerminalManager {
    let terminalCounter = 0;
    const sessionsById = new Map<string, TerminalSession>();

    return {
      async getTerminals() {
        return [];
      },
      async createTerminal(options: CreateTerminalCall): Promise<TerminalSession> {
        createTerminalCalls.push(options);
        terminalCounter += 1;
        const terminalId = `term-${terminalCounter}`;
        let exitHandler: ((info: { exitCode: number | null }) => void) | null = null;
        let commandFinishedHandler: ((info: { exitCode: number | null }) => void) | null = null;
        const sentInputs: string[] = [];
        terminalRecords.push({
          id: terminalId,
          sentInputs,
          triggerCommandFinished: (exitCode) => {
            commandFinishedHandler?.({ exitCode });
          },
          triggerExit: (exitCode) => {
            if (exitHandler) {
              exitHandler({ exitCode });
            }
          },
        });

        const session: TerminalSession = {
          id: terminalId,
          name: options.name ?? "Terminal",
          cwd: options.cwd,
          send: (message) => {
            if (message.type === "input") {
              sentInputs.push(message.data);
            }
          },
          subscribe: () => () => {},
          onExit: (handler) => {
            exitHandler = handler;
            return () => {
              if (exitHandler === handler) {
                exitHandler = null;
              }
            };
          },
          onCommandFinished: (handler) => {
            commandFinishedHandler = handler;
            return () => {
              if (commandFinishedHandler === handler) {
                commandFinishedHandler = null;
              }
            };
          },
          getState: () => ({
            rows: 1,
            cols: 1,
            grid: [[{ char: "$" }]],
            scrollback: [],
            cursor: { row: 0, col: 0 },
          }),
          kill: () => {},
          onTitleChange: () => () => {},
          getSize: () => ({ rows: 1, cols: 1 }),
          getTitle: () => undefined,
          getExitInfo: () => null,
          killAndWait: async () => {},
        };
        sessionsById.set(terminalId, session);
        return session;
      },
      registerCwdEnv() {},
      getTerminal(id) {
        return sessionsById.get(id);
      },
      killTerminal() {},
      async killTerminalAndWait() {},
      listDirectories() {
        return [];
      },
      killAll() {},
      subscribeTerminalsChanged() {
        return () => {};
      },
    };
  }

  function assertServiceTerminalCallSelfEnv(params: {
    createTerminalCalls: CreateTerminalCall[];
    terminalRecords: StubTerminalRecord[];
    repoDir: string;
  }): void {
    const { createTerminalCalls, terminalRecords, repoDir: testRepoDir } = params;
    expect(createTerminalCalls).toHaveLength(1);
    expect(createTerminalCalls[0]?.cwd).toBe(testRepoDir);
    expect(createTerminalCalls[0]?.name).toBe("api");
    expect(terminalRecords[0]?.sentInputs).toEqual(["npm run api\r"]);
    expect(createTerminalCalls[0]?.env).not.toHaveProperty("PORT");
    expect(createTerminalCalls[0]?.env?.PASEO_PORT).toEqual(expect.any(String));
    expect(createTerminalCalls[0]?.env?.HOST).toBe("127.0.0.1");
    expect(createTerminalCalls[0]?.env?.PASEO_URL).toBe(
      "http://api.feature-socket-service.repo.localhost:6767",
    );
    expect(createTerminalCalls[0]?.env?.PASEO_SERVICE_API_PORT).toBe(
      createTerminalCalls[0]?.env?.PASEO_PORT,
    );
    expect(createTerminalCalls[0]?.env?.PASEO_SERVICE_API_URL).toBe(
      "http://api.feature-socket-service.repo.localhost:6767",
    );
  }

  async function assertServiceTerminalCallPeerEnv(params: {
    createTerminalCalls: CreateTerminalCall[];
    repoDir: string;
  }): Promise<void> {
    const { createTerminalCalls, repoDir: testRepoDir } = params;
    const plannedPorts = await ensureWorkspaceServicePortPlan({
      workspaceId: testRepoDir,
      services: [{ scriptName: "api" }, { scriptName: "app-server" }],
      allocatePort: async () => {
        throw new Error("Peer env test should reuse the existing service port plan");
      },
    });
    const plannedAppServerPort = plannedPorts.get("app-server");
    if (plannedAppServerPort === undefined) {
      throw new Error("Expected app-server to be present in the service port plan");
    }
    expect(createTerminalCalls[0]?.env?.PASEO_SERVICE_APP_SERVER_PORT).toBe(
      String(plannedAppServerPort),
    );
    expect(createTerminalCalls[0]?.env?.PASEO_SERVICE_APP_SERVER_URL).toBe(
      "http://app-server.feature-socket-service.repo.localhost:6767",
    );
  }

  async function assertServiceTerminalCallEnv(params: {
    createTerminalCalls: CreateTerminalCall[];
    terminalRecords: StubTerminalRecord[];
    repoDir: string;
  }): Promise<void> {
    assertServiceTerminalCallSelfEnv(params);
    await assertServiceTerminalCallPeerEnv({
      createTerminalCalls: params.createTerminalCalls,
      repoDir: params.repoDir,
    });
  }

  function commitPaseoScripts(
    scripts: Record<string, { command: string; type?: "script" | "service" }>,
    message = "add script config",
  ): void {
    writeFileSync(join(repoDir, "paseo.json"), JSON.stringify({ scripts }));
    execFileSync("git", ["add", "paseo.json"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", message], {
      cwd: repoDir,
      stdio: "pipe",
    });
  }

  it("spawns plain scripts in persistent shell terminals without env injection or routes", async () => {
    commitPaseoScripts({
      web: {
        command: "npm run dev",
      },
    });

    const routeStore = new ScriptRouteStore();
    const runtimeStore = new WorkspaceScriptRuntimeStore();
    const createTerminalCalls: CreateTerminalCall[] = [];
    const terminalRecords: StubTerminalRecord[] = [];

    const result = await spawnWorkspaceScript({
      repoRoot: repoDir,
      workspaceId: repoDir,
      projectSlug: "repo",
      branchName: "feature-socket-service",
      scriptName: "web",
      daemonPort: null,
      routeStore,
      runtimeStore,
      terminalManager: createStubTerminalManager(createTerminalCalls, terminalRecords),
    });

    expect(result).toBeDefined();
    expect(routeStore.listRoutes()).toEqual([]);
    expect(createTerminalCalls).toHaveLength(1);
    expect(createTerminalCalls[0]?.cwd).toBe(repoDir);
    expect(createTerminalCalls[0]?.name).toBe("web");
    expect(createTerminalCalls[0]?.title).toBe("web");
    expect(createTerminalCalls[0]?.env).toBeUndefined();
    expect(terminalRecords[0]?.sentInputs).toEqual(["npm run dev\r"]);
    expect(runtimeStore.get({ workspaceId: repoDir, scriptName: "web" })).toMatchObject({
      type: "script",
      lifecycle: "running",
      exitCode: null,
      terminalId: "term-1",
    });
  });

  it("records plain script exit codes from shell command completion without terminal exit", async () => {
    commitPaseoScripts(
      {
        typecheck: {
          command: 'node -e "process.exit(7)"',
        },
      },
      "add one-off script config",
    );

    const routeStore = new ScriptRouteStore();
    const runtimeStore = new WorkspaceScriptRuntimeStore();
    const createTerminalCalls: CreateTerminalCall[] = [];
    const terminalRecords: StubTerminalRecord[] = [];
    const terminalManager = createStubTerminalManager(createTerminalCalls, terminalRecords);

    const result = await spawnWorkspaceScript({
      repoRoot: repoDir,
      workspaceId: repoDir,
      projectSlug: "repo",
      branchName: "feature-script-exit",
      scriptName: "typecheck",
      daemonPort: null,
      routeStore,
      runtimeStore,
      terminalManager,
    });

    expect(createTerminalCalls).toHaveLength(1);
    terminalRecords[0]?.triggerCommandFinished(7);
    expect(runtimeStore.get({ workspaceId: repoDir, scriptName: "typecheck" })).toMatchObject({
      type: "script",
      lifecycle: "stopped",
      terminalId: result.terminalId,
      exitCode: 7,
    });
    expect(terminalRecords[0]?.sentInputs).toEqual(['node -e "process.exit(7)"\r']);
  });

  it("reuses a live terminal when rerunning after plain script completion", async () => {
    commitPaseoScripts(
      {
        typecheck: {
          command: "npm run typecheck",
        },
      },
      "add one-off script config",
    );

    const routeStore = new ScriptRouteStore();
    const runtimeStore = new WorkspaceScriptRuntimeStore();
    const createTerminalCalls: CreateTerminalCall[] = [];
    const terminalRecords: StubTerminalRecord[] = [];
    const terminalManager = createStubTerminalManager(createTerminalCalls, terminalRecords);

    const firstResult = await spawnWorkspaceScript({
      repoRoot: repoDir,
      workspaceId: repoDir,
      projectSlug: "repo",
      branchName: "feature-script-rerun",
      scriptName: "typecheck",
      daemonPort: null,
      routeStore,
      runtimeStore,
      terminalManager,
    });

    terminalRecords[0]?.triggerCommandFinished(7);
    expect(runtimeStore.get({ workspaceId: repoDir, scriptName: "typecheck" })).toMatchObject({
      type: "script",
      lifecycle: "stopped",
      terminalId: firstResult.terminalId,
      exitCode: 7,
    });

    const secondResult = await spawnWorkspaceScript({
      repoRoot: repoDir,
      workspaceId: repoDir,
      projectSlug: "repo",
      branchName: "feature-script-rerun",
      scriptName: "typecheck",
      daemonPort: null,
      routeStore,
      runtimeStore,
      terminalManager,
    });

    expect(secondResult.terminalId).toBe(firstResult.terminalId);
    expect(createTerminalCalls).toHaveLength(1);
    expect(terminalRecords[0]?.sentInputs).toEqual(["npm run typecheck\r", "npm run typecheck\r"]);
    expect(runtimeStore.get({ workspaceId: repoDir, scriptName: "typecheck" })).toMatchObject({
      type: "script",
      lifecycle: "running",
      terminalId: firstResult.terminalId,
      exitCode: null,
    });
    terminalRecords[0]?.triggerCommandFinished(0);
    expect(runtimeStore.get({ workspaceId: repoDir, scriptName: "typecheck" })).toMatchObject({
      type: "script",
      lifecycle: "stopped",
      terminalId: firstResult.terminalId,
      exitCode: 0,
    });
  });

  it("tracks command completion when reusing a live terminal from a stopped plain script entry", async () => {
    commitPaseoScripts(
      {
        typecheck: {
          command: "npm run typecheck",
        },
      },
      "add one-off script config",
    );

    const routeStore = new ScriptRouteStore();
    const runtimeStore = new WorkspaceScriptRuntimeStore();
    const createTerminalCalls: CreateTerminalCall[] = [];
    const terminalRecords: StubTerminalRecord[] = [];
    const terminalManager = createStubTerminalManager(createTerminalCalls, terminalRecords);
    const existingTerminal = await terminalManager.createTerminal({
      cwd: repoDir,
      name: "typecheck",
      title: "typecheck",
    });
    runtimeStore.set({
      workspaceId: repoDir,
      scriptName: "typecheck",
      type: "script",
      lifecycle: "stopped",
      terminalId: existingTerminal.id,
      exitCode: 1,
    });

    const result = await spawnWorkspaceScript({
      repoRoot: repoDir,
      workspaceId: repoDir,
      projectSlug: "repo",
      branchName: "feature-script-existing-terminal",
      scriptName: "typecheck",
      daemonPort: null,
      routeStore,
      runtimeStore,
      terminalManager,
    });

    expect(result.terminalId).toBe(existingTerminal.id);
    expect(createTerminalCalls).toHaveLength(1);
    expect(terminalRecords[0]?.sentInputs).toEqual(["npm run typecheck\r"]);

    terminalRecords[0]?.triggerCommandFinished(0);

    expect(runtimeStore.get({ workspaceId: repoDir, scriptName: "typecheck" })).toMatchObject({
      type: "script",
      lifecycle: "stopped",
      terminalId: existingTerminal.id,
      exitCode: 0,
    });
  });

  it("uses terminal exit as a fallback before shell command completion", async () => {
    commitPaseoScripts(
      {
        typecheck: {
          command: "npm run typecheck",
        },
      },
      "add one-off script config",
    );

    const routeStore = new ScriptRouteStore();
    const runtimeStore = new WorkspaceScriptRuntimeStore();
    const createTerminalCalls: CreateTerminalCall[] = [];
    const terminalRecords: StubTerminalRecord[] = [];
    const terminalManager = createStubTerminalManager(createTerminalCalls, terminalRecords);

    const result = await spawnWorkspaceScript({
      repoRoot: repoDir,
      workspaceId: repoDir,
      projectSlug: "repo",
      branchName: "feature-script-terminal-exit",
      scriptName: "typecheck",
      daemonPort: null,
      routeStore,
      runtimeStore,
      terminalManager,
    });

    terminalRecords[0]?.triggerExit(9);

    expect(runtimeStore.get({ workspaceId: repoDir, scriptName: "typecheck" })).toMatchObject({
      type: "script",
      lifecycle: "stopped",
      terminalId: result.terminalId,
      exitCode: 9,
    });
  });

  it("rejects duplicate plain script starts while running", async () => {
    commitPaseoScripts(
      {
        typecheck: {
          command: 'node -e "setTimeout(() => {}, 30000)"',
        },
      },
      "add long-running one-off script",
    );

    const routeStore = new ScriptRouteStore();
    const runtimeStore = new WorkspaceScriptRuntimeStore();
    const createTerminalCalls: CreateTerminalCall[] = [];
    const terminalManager = createStubTerminalManager(createTerminalCalls);

    await spawnWorkspaceScript({
      repoRoot: repoDir,
      workspaceId: repoDir,
      projectSlug: "repo",
      branchName: "feature-script-duplicate",
      scriptName: "typecheck",
      daemonPort: null,
      routeStore,
      runtimeStore,
      terminalManager,
    });

    await expect(
      spawnWorkspaceScript({
        repoRoot: repoDir,
        workspaceId: repoDir,
        projectSlug: "repo",
        branchName: "feature-script-duplicate",
        scriptName: "typecheck",
        daemonPort: null,
        routeStore,
        runtimeStore,
        terminalManager,
      }),
    ).rejects.toThrow("Script 'typecheck' is already running");
    expect(createTerminalCalls).toHaveLength(1);
  });

  it("spawns services with route registration and injected peer service env vars", async () => {
    commitPaseoScripts(
      {
        api: {
          type: "service",
          command: "npm run api",
        },
        "app-server": {
          type: "service",
          command: "npm run app",
        },
      },
      "add service script config",
    );

    const routeStore = new ScriptRouteStore();
    const runtimeStore = new WorkspaceScriptRuntimeStore();
    const createTerminalCalls: CreateTerminalCall[] = [];
    const terminalRecords: StubTerminalRecord[] = [];

    const result = await spawnWorkspaceScript({
      repoRoot: repoDir,
      workspaceId: repoDir,
      projectSlug: "repo",
      branchName: "feature-socket-service",
      scriptName: "api",
      daemonPort: 6767,
      routeStore,
      runtimeStore,
      terminalManager: createStubTerminalManager(createTerminalCalls, terminalRecords),
    });

    expect(result.scriptName).toBe("api");
    expect(routeStore.listRoutes()).toEqual([
      {
        hostname: "api.feature-socket-service.repo.localhost",
        port: expect.any(Number),
        workspaceId: repoDir,
        projectSlug: "repo",
        scriptName: "api",
      },
    ]);
    await assertServiceTerminalCallEnv({
      createTerminalCalls,
      terminalRecords,
      repoDir,
    });
    expect(runtimeStore.get({ workspaceId: repoDir, scriptName: "api" })).toMatchObject({
      type: "service",
      lifecycle: "running",
      exitCode: null,
    });
  });

  it("refreshes a stopped service port on respawn and updates the route", async () => {
    writeFileSync(
      join(repoDir, "paseo.json"),
      JSON.stringify({
        scripts: {
          api: {
            type: "service",
            command: "npm run api",
          },
          worker: {
            type: "service",
            command: "npm run worker",
          },
        },
      }),
    );
    execFileSync("git", ["add", "paseo.json"], { cwd: repoDir, stdio: "pipe" });
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "commit", "-m", "add respawn service script config"],
      {
        cwd: repoDir,
        stdio: "pipe",
      },
    );

    const routeStore = new ScriptRouteStore();
    const runtimeStore = new WorkspaceScriptRuntimeStore();
    const createTerminalCalls: CreateTerminalCall[] = [];
    const terminalRecords: StubTerminalRecord[] = [];
    const terminalManager = createStubTerminalManager(createTerminalCalls, terminalRecords);

    const firstResult = await spawnWorkspaceScript({
      repoRoot: repoDir,
      workspaceId: repoDir,
      projectSlug: "repo",
      branchName: "feature-respawn-service",
      scriptName: "api",
      daemonPort: 6767,
      routeStore,
      runtimeStore,
      terminalManager,
    });

    const workerResult = await spawnWorkspaceScript({
      repoRoot: repoDir,
      workspaceId: repoDir,
      projectSlug: "repo",
      branchName: "feature-respawn-service",
      scriptName: "worker",
      daemonPort: 6767,
      routeStore,
      runtimeStore,
      terminalManager,
    });

    expect(firstResult.port).toEqual(expect.any(Number));
    const firstPort = firstResult.port;
    if (firstPort === null) {
      throw new Error("Expected first service spawn to return a port");
    }
    const workerPort = workerResult.port;
    if (workerPort === null) {
      throw new Error("Expected worker service spawn to return a port");
    }

    const firstTerminal = terminalRecords[0];
    if (!firstTerminal) {
      throw new Error("Expected first terminal record");
    }
    firstTerminal.triggerExit(0);

    expect(runtimeStore.get({ workspaceId: repoDir, scriptName: "api" })).toMatchObject({
      lifecycle: "stopped",
      exitCode: 0,
    });
    expect(routeStore.getRouteEntry("api.feature-respawn-service.repo.localhost")).toBeNull();

    const secondResult = await spawnWorkspaceScript({
      repoRoot: repoDir,
      workspaceId: repoDir,
      projectSlug: "repo",
      branchName: "feature-respawn-service",
      scriptName: "api",
      daemonPort: 6767,
      routeStore,
      runtimeStore,
      terminalManager,
    });

    expect(secondResult.port).toEqual(expect.any(Number));
    const secondPort = secondResult.port;
    if (secondPort === null) {
      throw new Error("Expected second service spawn to return a port");
    }
    expect(secondPort).not.toBe(firstPort);
    expect(secondPort).toEqual(expect.any(Number));
    expect(createTerminalCalls[2]?.env?.PASEO_SERVICE_WORKER_PORT).toBe(String(workerPort));
    expect(routeStore.getRouteEntry("api.feature-respawn-service.repo.localhost")).toMatchObject({
      hostname: "api.feature-respawn-service.repo.localhost",
      port: secondPort,
      workspaceId: repoDir,
      projectSlug: "repo",
      scriptName: "api",
    });
  });

  it("removes the current service route on exit after a branch rename", async () => {
    writeFileSync(
      join(repoDir, "paseo.json"),
      JSON.stringify({
        scripts: {
          api: {
            type: "service",
            command: "npm run api",
          },
        },
      }),
    );
    execFileSync("git", ["add", "paseo.json"], { cwd: repoDir, stdio: "pipe" });
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "commit", "-m", "add renamed service script config"],
      {
        cwd: repoDir,
        stdio: "pipe",
      },
    );

    const routeStore = new ScriptRouteStore();
    const runtimeStore = new WorkspaceScriptRuntimeStore();
    const createTerminalCalls: CreateTerminalCall[] = [];
    const terminalRecords: StubTerminalRecord[] = [];
    const terminalManager = createStubTerminalManager(createTerminalCalls, terminalRecords);

    await spawnWorkspaceScript({
      repoRoot: repoDir,
      workspaceId: repoDir,
      projectSlug: "repo",
      branchName: "feature-before-rename",
      scriptName: "api",
      daemonPort: 6767,
      routeStore,
      runtimeStore,
      terminalManager,
    });

    const updateRoutesForBranchChange = createBranchChangeRouteHandler({
      routeStore,
      onRoutesChanged: () => {},
    });
    updateRoutesForBranchChange(repoDir, "feature-before-rename", "feature-after-rename");

    expect(routeStore.listRoutesForWorkspace(repoDir)).toEqual([
      expect.objectContaining({
        hostname: "api.feature-after-rename.repo.localhost",
        scriptName: "api",
      }),
    ]);

    const terminal = terminalRecords[0];
    if (!terminal) {
      throw new Error("Expected terminal record");
    }
    terminal.triggerExit(0);

    expect(routeStore.listRoutesForWorkspace(repoDir)).toEqual([]);
  });

  it("fails normalized service env name collisions before terminal creation", async () => {
    writeFileSync(
      join(repoDir, "paseo.json"),
      JSON.stringify({
        scripts: {
          "app-server": {
            type: "service",
            command: "npm run app-server",
          },
          "app.server": {
            type: "service",
            command: "npm run app-dot-server",
          },
        },
      }),
    );
    execFileSync("git", ["add", "paseo.json"], { cwd: repoDir, stdio: "pipe" });
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "commit", "-m", "add colliding service config"],
      {
        cwd: repoDir,
        stdio: "pipe",
      },
    );

    const routeStore = new ScriptRouteStore();
    const runtimeStore = new WorkspaceScriptRuntimeStore();
    const createTerminalCalls: CreateTerminalCall[] = [];

    await expect(
      spawnWorkspaceScript({
        repoRoot: repoDir,
        workspaceId: repoDir,
        projectSlug: "repo",
        branchName: "feature-collision-service",
        scriptName: "app-server",
        daemonPort: 6767,
        routeStore,
        runtimeStore,
        terminalManager: createStubTerminalManager(createTerminalCalls),
      }),
    ).rejects.toThrow("Service env name collision for APP_SERVER: app-server, app.server");

    expect(createTerminalCalls).toHaveLength(0);
    expect(routeStore.listRoutes()).toEqual([]);
    expect(
      routeStore.getRouteEntry("app-server.feature-collision-service.repo.localhost"),
    ).toBeNull();

    writeFileSync(
      join(repoDir, "paseo.json"),
      JSON.stringify({
        scripts: {
          "app-server": {
            type: "service",
            command: "npm run app-server",
          },
          worker: {
            type: "service",
            command: "npm run worker",
          },
        },
      }),
    );

    await spawnWorkspaceScript({
      repoRoot: repoDir,
      workspaceId: repoDir,
      projectSlug: "repo",
      branchName: "feature-collision-service",
      scriptName: "app-server",
      daemonPort: 6767,
      routeStore,
      runtimeStore,
      terminalManager: createStubTerminalManager(createTerminalCalls),
    });

    const plan = await ensureWorkspaceServicePortPlan({
      workspaceId: repoDir,
      services: [{ scriptName: "app-server" }, { scriptName: "worker" }],
      allocatePort: async () => {
        throw new Error("Collision recovery should reuse the fixed service port plan");
      },
    });

    expect(Array.from(plan.keys())).toEqual(["app-server", "worker"]);
    expect(createTerminalCalls).toHaveLength(1);
    expect(createTerminalCalls[0]?.env).toHaveProperty("PASEO_SERVICE_APP_SERVER_PORT");
    expect(createTerminalCalls[0]?.env).toHaveProperty("PASEO_SERVICE_WORKER_PORT");
  });

  it("binds services to the network when the daemon listens on a non-loopback host", async () => {
    writeFileSync(
      join(repoDir, "paseo.json"),
      JSON.stringify({
        scripts: {
          web: {
            type: "service",
            command: "npm run dev",
          },
        },
      }),
    );
    execFileSync("git", ["add", "paseo.json"], { cwd: repoDir, stdio: "pipe" });
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "commit", "-m", "add remote service script config"],
      {
        cwd: repoDir,
        stdio: "pipe",
      },
    );

    const routeStore = new ScriptRouteStore();
    const runtimeStore = new WorkspaceScriptRuntimeStore();
    const createTerminalCalls: CreateTerminalCall[] = [];

    await spawnWorkspaceScript({
      repoRoot: repoDir,
      workspaceId: repoDir,
      projectSlug: "repo",
      branchName: "feature-remote-service",
      scriptName: "web",
      daemonPort: 6767,
      daemonListenHost: "100.64.0.20",
      routeStore,
      runtimeStore,
      terminalManager: createStubTerminalManager(createTerminalCalls),
    });

    expect(createTerminalCalls).toHaveLength(1);
    expect(createTerminalCalls[0]?.env?.HOST).toBe("0.0.0.0");
    expect(createTerminalCalls[0]?.env?.PASEO_URL).toBe(
      "http://web.feature-remote-service.repo.localhost:6767",
    );
  });
});
