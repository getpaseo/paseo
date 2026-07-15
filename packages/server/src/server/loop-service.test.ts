import os from "node:os";
import path from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, expect, test } from "vitest";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentLaunchContext,
  AgentMode,
  AgentModelDefinition,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentSlashCommand,
  AgentRuntimeInfo,
  AgentProvider,
} from "./agent/agent-sdk-types.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { AgentManager } from "./agent/agent-manager.js";
import { createAgentCommand } from "./agent/create-agent/create.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import { createLocalCheckoutWorkspace } from "./paseo-worktree-service.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";
import { FileBackedProjectRegistry, FileBackedWorkspaceRegistry } from "./workspace-registry.js";
import { LoopService } from "./loop-service.js";
import { isPlatform } from "../test-utils/platform.js";
import { createTestLogger } from "../test-utils/test-logger.js";

const TEST_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

const NO_UNATTENDED_LOOP_POLICY: Pick<ProviderSnapshotManager, "resolveCreateConfig"> = {
  async resolveCreateConfig(input) {
    expect(input).toMatchObject({ parent: null, unattended: true });
    return {
      modeId: input.unattended ? input.requestedMode : "interactive",
      featureValues: input.featureValues,
    };
  },
};

interface TestLoopServiceOptions {
  paseoHome: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: ReturnType<typeof createTestLogger>;
  providerSnapshotManager?: Pick<ProviderSnapshotManager, "resolveCreateConfig">;
  ensureWorkspaceForCreate?: (
    cwd: string,
    firstAgentContext?: { prompt: string },
  ) => Promise<string>;
}

function createLoopService(options: TestLoopServiceOptions): LoopService {
  const providerSnapshotManager = options.providerSnapshotManager ?? NO_UNATTENDED_LOOP_POLICY;
  const ensureWorkspaceForCreate =
    options.ensureWorkspaceForCreate ?? (async () => "workspace-created-for-loop");
  return new LoopService({
    paseoHome: options.paseoHome,
    agentManager: options.agentManager,
    logger: options.logger,
    ensureWorkspaceForCreate,
    createAgent: (input) =>
      createAgentCommand(
        {
          agentManager: options.agentManager,
          agentStorage: options.agentStorage,
          logger: options.logger,
          providerSnapshotManager: providerSnapshotManager as ProviderSnapshotManager,
          ensureWorkspaceForCreate,
        },
        input,
      ),
  });
}

async function createRegistryBackedWorkspaceEnsure(rootDir: string): Promise<{
  workspaceRegistry: FileBackedWorkspaceRegistry;
  ensureWorkspaceForCreate: TestLoopServiceOptions["ensureWorkspaceForCreate"];
}> {
  const workspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(rootDir, "projects", "workspaces.json"),
    createTestLogger(),
  );
  const projectRegistry = new FileBackedProjectRegistry(
    path.join(rootDir, "projects", "projects.json"),
    createTestLogger(),
  );
  await workspaceRegistry.initialize();
  await projectRegistry.initialize();
  const workspaceGitService = createNoopWorkspaceGitService();
  return {
    workspaceRegistry,
    ensureWorkspaceForCreate: async (cwd, firstAgentContext) => {
      const workspace = await createLocalCheckoutWorkspace(
        { cwd, title: firstAgentContext?.prompt ?? null },
        { projectRegistry, workspaceRegistry, workspaceGitService },
      );
      return workspace.workspaceId;
    },
  };
}

interface ScriptedAgentBehavior {
  onRun(input: { config: AgentSessionConfig; prompt: string; turnId: string }): Promise<string>;
}

class ScriptedAgentClient implements AgentClient {
  readonly provider: AgentProvider;
  readonly capabilities = TEST_CAPABILITIES;

  constructor(
    provider: AgentProvider,
    private readonly behavior: ScriptedAgentBehavior,
  ) {
    this.provider = provider;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(
    config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    return new ScriptedAgentSession(config, this.provider, this.behavior);
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    return new ScriptedAgentSession(
      {
        provider: this.provider,
        cwd: overrides?.cwd ?? process.cwd(),
        ...overrides,
      },
      this.provider,
      this.behavior,
    );
  }

  async fetchCatalog(): Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }> {
    return { models: [], modes: [] };
  }
}

class ScriptedAgentSession implements AgentSession {
  readonly capabilities = TEST_CAPABILITIES;
  readonly id = randomUUID();
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turnCount = 0;
  private interrupted = false;

  constructor(
    private readonly config: AgentSessionConfig,
    readonly provider: AgentProvider,
    private readonly behavior: ScriptedAgentBehavior,
  ) {}

  async run(): Promise<AgentRunResult> {
    return {
      sessionId: this.id,
      finalText: "",
      timeline: [],
    };
  }

  async startTurn(
    prompt: AgentPromptInput,
    _options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    const promptText = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
    const turnId = `turn-${++this.turnCount}`;
    this.interrupted = false;
    queueMicrotask(() => {
      void this.runScript(promptText, turnId);
    });
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.config.model ?? null,
      modeId: this.config.modeId ?? null,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [];
  }

  async getCurrentMode(): Promise<string | null> {
    return this.config.modeId ?? null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence(): AgentPersistenceHandle {
    return {
      provider: this.provider,
      sessionId: this.id,
    };
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
  }

  async close(): Promise<void> {}

  async listCommands(): Promise<AgentSlashCommand[]> {
    return [];
  }

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  private async runScript(prompt: string, turnId: string): Promise<void> {
    this.emit({ type: "turn_started", provider: this.provider, turnId });
    if (this.interrupted) {
      this.emit({ type: "turn_canceled", provider: this.provider, reason: "interrupted", turnId });
      return;
    }

    try {
      const responseText = await this.behavior.onRun({
        config: this.config,
        prompt,
        turnId,
      });
      if (this.interrupted) {
        this.emit({
          type: "turn_canceled",
          provider: this.provider,
          reason: "interrupted",
          turnId,
        });
        return;
      }
      this.emit({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: { type: "assistant_message", text: responseText },
      });
      this.emit({ type: "turn_completed", provider: this.provider, turnId });
    } catch (error) {
      this.emit({
        type: "turn_failed",
        provider: this.provider,
        turnId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

describe("LoopService", () => {
  const logger = createTestLogger();
  let tmpDir: string;
  let paseoHome: string;
  let workspaceDir: string;
  let storage: AgentStorage;

  beforeEach(() => {
    tmpDir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "loop-service-")));
    paseoHome = path.join(tmpDir, "paseo-home");
    workspaceDir = path.join(tmpDir, "workspace");
    storage = new AgentStorage(path.join(tmpDir, "agents"), logger);
    mkdirSync(workspaceDir, { recursive: true });
    workspaceDir = realpathSync.native(workspaceDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // POSIX-only: real worker agent spawns a PTY whose Windows ConPTY path resolution still fails (error 267) after realpathSync; revisit when we have a Windows dev box.
  test.skipIf(isPlatform("win32"))(
    "runs fresh worker agents until verify-check passes",
    async () => {
      const state = { workerRuns: 0 };
      const verifyScriptPath = path.join(workspaceDir, "verify-check.cjs");
      writeFileSync(verifyScriptPath, 'require("fs").accessSync("done.txt");\n');
      const manager = new AgentManager({
        clients: {
          claude: new ScriptedAgentClient("claude", {
            async onRun({ config }) {
              state.workerRuns += 1;
              if (config.title?.includes("worker") && state.workerRuns >= 2) {
                writeFileSync(path.join(workspaceDir, "done.txt"), "ok");
              }
              if (config.title?.includes("worker")) {
                return `worker run ${state.workerRuns}`;
              }
              return '{"passed":true,"reason":"not used"}';
            },
          }),
        },
        registry: storage,
        logger,
      });
      const service = createLoopService({
        paseoHome,
        agentManager: manager,
        agentStorage: storage,
        logger,
      });
      await service.initialize();

      const loop = await service.runLoop({
        prompt: "Create done.txt when the task is actually fixed.",
        cwd: workspaceDir,
        model: "test-model",
        verifyChecks: [
          `${JSON.stringify(process.execPath)} ${JSON.stringify(path.basename(verifyScriptPath))}`,
        ],
        sleepMs: 1,
        maxIterations: 3,
      });

      await waitForLoopCompletion(service, loop.id);

      const finalLoop = await service.inspectLoop(loop.id);
      expect(finalLoop.status).toBe("succeeded");
      expect(finalLoop.iterations).toHaveLength(2);
      expect(finalLoop.iterations[0]?.workerAgentId).not.toBe(
        finalLoop.iterations[1]?.workerAgentId,
      );
      expect(finalLoop.iterations[0]?.status).toBe("failed");
      expect(finalLoop.iterations[1]?.status).toBe("succeeded");
      expect(finalLoop.iterations[0]?.verifyChecks[0]?.passed).toBe(false);
      expect(finalLoop.iterations[1]?.verifyChecks[0]?.passed).toBe(true);
      expect(readFileSync(path.join(paseoHome, "loops", "loops.json"), "utf8")).toContain(loop.id);
    },
  );

  test("uses worker and verifier provider-model settings when provided", async () => {
    const workerConfigs: AgentSessionConfig[] = [];
    const verifierConfigs: AgentSessionConfig[] = [];
    const manager = new AgentManager({
      clients: {
        codex: new ScriptedAgentClient("codex", {
          async onRun({ config }) {
            workerConfigs.push(config);
            writeFileSync(path.join(workspaceDir, "done.txt"), "ok");
            return "done";
          },
        }),
        claude: new ScriptedAgentClient("claude", {
          async onRun({ config }) {
            verifierConfigs.push(config);
            return '{"passed":true,"reason":"verified"}';
          },
        }),
      },
      registry: storage,
      logger,
    });
    const service = createLoopService({
      paseoHome,
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await service.initialize();

    const loop = await service.runLoop({
      prompt: "Create done.txt",
      cwd: workspaceDir,
      provider: "codex",
      model: "fallback-model",
      workerModel: "gpt-5.4",
      verifyPrompt: "Confirm that done.txt exists in the workspace.",
      verifierProvider: "claude",
      verifierModel: "sonnet",
      maxIterations: 1,
    });

    await waitForLoopCompletion(service, loop.id);

    const finalLoop = await service.inspectLoop(loop.id);
    expect(finalLoop.status).toBe("succeeded");
    expect(finalLoop.provider).toBe("codex");
    expect(finalLoop.model).toBe("fallback-model");
    expect(finalLoop.workerProvider).toBeNull();
    expect(finalLoop.workerModel).toBe("gpt-5.4");
    expect(finalLoop.verifierProvider).toBe("claude");
    expect(finalLoop.verifierModel).toBe("sonnet");
    expect(workerConfigs).toHaveLength(1);
    expect(workerConfigs[0]).toMatchObject({
      provider: "codex",
      model: "gpt-5.4",
    });
    expect(verifierConfigs).toHaveLength(1);
    expect(verifierConfigs[0]).toMatchObject({
      provider: "claude",
      model: "sonnet",
    });
  });

  test("loop worker and verifier agents share one registry workspace across iterations", async () => {
    const { workspaceRegistry, ensureWorkspaceForCreate } =
      await createRegistryBackedWorkspaceEnsure(tmpDir);
    let verifierCount = 0;
    const manager = new AgentManager({
      clients: {
        claude: new ScriptedAgentClient("claude", {
          async onRun({ config }) {
            if (config.title?.includes("worker")) {
              return "worker finished";
            }
            verifierCount += 1;
            return verifierCount >= 2
              ? '{"passed":true,"reason":"second verifier passed"}'
              : '{"passed":false,"reason":"try again"}';
          },
        }),
      },
      registry: storage,
      logger,
    });
    const service = createLoopService({
      paseoHome,
      agentManager: manager,
      agentStorage: storage,
      logger,
      ensureWorkspaceForCreate,
    });
    await service.initialize();

    const loop = await service.runLoop({
      prompt: "Keep trying until the verifier passes.",
      cwd: workspaceDir,
      model: "test-model",
      verifyPrompt: "Report whether the loop has passed.",
      archive: true,
      sleepMs: 1,
      maxIterations: 2,
    });

    await waitForLoopCompletion(service, loop.id);

    const finalLoop = await service.inspectLoop(loop.id);
    expect(finalLoop.status).toBe("succeeded");
    expect(finalLoop.iterations).toHaveLength(2);
    const firstWorker = await storage.get(finalLoop.iterations[0]!.workerAgentId!);
    const firstVerifier = await storage.get(finalLoop.iterations[0]!.verifierAgentId!);
    const secondWorker = await storage.get(finalLoop.iterations[1]!.workerAgentId!);
    const secondVerifier = await storage.get(finalLoop.iterations[1]!.verifierAgentId!);
    const workspaceId = firstWorker?.workspaceId;
    expect(workspaceId).toMatch(/^wks_/);
    expect(firstVerifier?.workspaceId).toBe(workspaceId);
    expect(secondWorker?.workspaceId).toBe(workspaceId);
    expect(secondVerifier?.workspaceId).toBe(workspaceId);
    expect(await workspaceRegistry.get(workspaceId!)).toMatchObject({
      workspaceId,
      cwd: workspaceDir,
    });
    expect(await workspaceRegistry.list()).toHaveLength(1);
  });

  test("rejects non-directory cwd before minting a loop workspace", async () => {
    const filePath = path.join(tmpDir, "not-a-directory.txt");
    writeFileSync(filePath, "not a directory");
    let ensureCalls = 0;
    const manager = new AgentManager({ registry: storage, logger });
    const service = createLoopService({
      paseoHome,
      agentManager: manager,
      agentStorage: storage,
      logger,
      ensureWorkspaceForCreate: async () => {
        ensureCalls += 1;
        return "workspace-created-for-file-cwd";
      },
    });
    await service.initialize();

    await expect(
      service.runLoop({
        prompt: "Use a file as cwd",
        cwd: filePath,
        verifyChecks: ["true"],
      }),
    ).rejects.toThrow("is not a directory");
    expect(ensureCalls).toBe(0);
  });

  test("model-less loop workers use provider defaults and keep fast worker logs", async () => {
    const workerConfigs: AgentSessionConfig[] = [];
    const manager = new AgentManager({
      clients: {
        claude: new ScriptedAgentClient("claude", {
          async onRun({ config }) {
            if (config.title?.includes("worker")) {
              workerConfigs.push(config);
              return "worker default model output";
            }
            return '{"passed":true,"reason":"ok"}';
          },
        }),
      },
      registry: storage,
      logger,
    });
    const service = createLoopService({
      paseoHome,
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await service.initialize();

    const loop = await service.runLoop({
      prompt: "Use provider default model",
      cwd: workspaceDir,
      verifyChecks: ["true"],
      maxIterations: 1,
    });

    await waitForLoopCompletion(service, loop.id);

    const finalLoop = await service.inspectLoop(loop.id);
    expect(finalLoop.status).toBe("succeeded");
    expect(workerConfigs).toHaveLength(1);
    expect(workerConfigs[0]).toMatchObject({
      provider: "claude",
      model: undefined,
    });
    expect(
      finalLoop.logs.some(
        (entry) => entry.source === "worker" && entry.text.includes("worker default model output"),
      ),
    ).toBe(true);
  });

  test("archives worker and verifier agents after each iteration when requested", async () => {
    const archivedAgentIds: string[] = [];
    const manager = new AgentManager({
      clients: {
        claude: new ScriptedAgentClient("claude", {
          async onRun({ config }) {
            if (config.title?.includes("worker")) {
              writeFileSync(path.join(workspaceDir, "done.txt"), "ok");
              return "created done.txt";
            }
            return '{"passed":true,"reason":"done.txt exists"}';
          },
        }),
      },
      registry: storage,
      logger,
    });
    const archiveAgent = manager.archiveAgent.bind(manager);
    manager.archiveAgent = async (agentId) => {
      archivedAgentIds.push(agentId);
      await archiveAgent(agentId);
    };
    const service = createLoopService({
      paseoHome,
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await service.initialize();

    const loop = await service.runLoop({
      prompt: "Create done.txt",
      cwd: workspaceDir,
      model: "test-model",
      verifyPrompt: "Confirm that done.txt exists in the workspace.",
      archive: true,
      maxIterations: 1,
    });

    await waitForLoopCompletion(service, loop.id);

    const finalLoop = await service.inspectLoop(loop.id);
    const iteration = finalLoop.iterations[0];
    expect(finalLoop.archive).toBe(true);
    expect(iteration?.workerAgentId).toBeTruthy();
    expect(iteration?.verifierAgentId).toBeTruthy();
    expect(archivedAgentIds).toEqual([iteration.workerAgentId!, iteration.verifierAgentId!]);
    await storage.flush();
    await expect(storage.get(iteration.workerAgentId!)).resolves.toMatchObject({
      id: iteration.workerAgentId!,
      archivedAt: expect.any(String),
      internal: true,
    });
    await expect(storage.get(iteration.verifierAgentId!)).resolves.toMatchObject({
      id: iteration.verifierAgentId!,
      archivedAt: expect.any(String),
      internal: true,
    });
  });

  test("worker prompt-start failures fail the loop and archive the worker", async () => {
    class StartFailureLoopSession implements AgentSession {
      readonly provider = "claude";
      readonly capabilities = TEST_CAPABILITIES;
      readonly id = randomUUID();

      async run(): Promise<AgentRunResult> {
        return {
          sessionId: this.id,
          finalText: "",
          timeline: [],
        };
      }

      async startTurn(): Promise<{ turnId: string }> {
        throw new Error("worker failed before starting");
      }

      subscribe(): () => void {
        return () => {};
      }

      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

      async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
        return {
          provider: this.provider,
          sessionId: this.id,
          model: null,
          modeId: null,
        };
      }

      async getAvailableModes(): Promise<AgentMode[]> {
        return [];
      }

      async getCurrentMode(): Promise<string | null> {
        return null;
      }

      async setMode(): Promise<void> {}

      getPendingPermissions(): AgentPermissionRequest[] {
        return [];
      }

      async respondToPermission(): Promise<void> {}

      describePersistence(): AgentPersistenceHandle {
        return {
          provider: this.provider,
          sessionId: this.id,
        };
      }

      async interrupt(): Promise<void> {}

      async close(): Promise<void> {}

      async listCommands(): Promise<AgentSlashCommand[]> {
        return [];
      }
    }

    const manager = new AgentManager({
      clients: {
        claude: {
          provider: "claude",
          capabilities: TEST_CAPABILITIES,
          createSession: async () => new StartFailureLoopSession(),
          resumeSession: async () => new StartFailureLoopSession(),
          fetchCatalog: async () => ({ models: [], modes: [] }),
          isAvailable: async () => true,
        },
      },
      registry: storage,
      logger,
    });
    const service = createLoopService({
      paseoHome,
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await service.initialize();

    const loop = await service.runLoop({
      prompt: "Fail before starting",
      cwd: workspaceDir,
      model: "test-model",
      verifyChecks: ["true"],
      archive: true,
      maxIterations: 1,
    });

    await waitForLoopCompletion(service, loop.id);

    const finalLoop = await service.inspectLoop(loop.id);
    expect(finalLoop.status).toBe("failed");
    expect(finalLoop.iterations[0]).toMatchObject({
      status: "failed",
      workerOutcome: "failed",
      failureReason: expect.stringContaining("worker failed before starting"),
    });
    const workerAgentId = finalLoop.iterations[0]?.workerAgentId;
    expect(workerAgentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await storage.get(workerAgentId!)).toMatchObject({
      archivedAt: expect.any(String),
    });
  });

  test("uses verifier prompt when provided", async () => {
    const manager = new AgentManager({
      clients: {
        claude: new ScriptedAgentClient("claude", {
          async onRun({ config }) {
            if (config.title?.includes("worker")) {
              await fsMkdir(workspaceDir);
              writeFileSync(path.join(workspaceDir, "done.txt"), "ok");
              return "created done.txt";
            }
            const exists = pathExists(path.join(workspaceDir, "done.txt"));
            return exists
              ? '{"passed":true,"reason":"done.txt exists"}'
              : '{"passed":false,"reason":"done.txt missing"}';
          },
        }),
      },
      registry: storage,
      logger,
    });
    const service = createLoopService({
      paseoHome,
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await service.initialize();

    const loop = await service.runLoop({
      prompt: "Create done.txt",
      cwd: workspaceDir,
      model: "test-model",
      verifyPrompt: "Confirm that done.txt exists in the workspace.",
      maxIterations: 1,
    });

    await waitForLoopCompletion(service, loop.id);

    const finalLoop = await service.inspectLoop(loop.id);
    expect(finalLoop.status).toBe("succeeded");
    expect(finalLoop.iterations[0]?.verifyPrompt).toMatchObject({
      passed: true,
      reason: "done.txt exists",
    });
    const logs = await service.getLoopLogs(loop.id);
    expect(logs.entries.some((entry) => entry.text.includes("Verifier result"))).toBe(true);
  });

  test("defaults worker and verifier modeId to provider's unattended mode", async () => {
    const workerConfigs: AgentSessionConfig[] = [];
    const verifierConfigs: AgentSessionConfig[] = [];
    const manager = new AgentManager({
      clients: {
        claude: new ScriptedAgentClient("claude", {
          async onRun({ config }) {
            if (config.title?.includes("worker")) {
              workerConfigs.push(config);
              writeFileSync(path.join(workspaceDir, "done.txt"), "ok");
              return "created done.txt";
            }
            verifierConfigs.push(config);
            return '{"passed":true,"reason":"ok"}';
          },
        }),
      },
      registry: storage,
      logger,
    });
    const service = createLoopService({
      paseoHome,
      agentManager: manager,
      agentStorage: storage,
      logger,
      providerSnapshotManager: {
        async resolveCreateConfig(input) {
          expect(input).toMatchObject({
            parent: null,
            unattended: true,
            requestedMode: undefined,
          });
          return {
            modeId: input.unattended ? "bypassPermissions" : "interactive",
            featureValues: input.featureValues,
          };
        },
      },
    });
    await service.initialize();

    const loop = await service.runLoop({
      prompt: "Create done.txt",
      cwd: workspaceDir,
      model: "test-model",
      verifyPrompt: "Confirm that done.txt exists in the workspace.",
      maxIterations: 1,
    });

    await waitForLoopCompletion(service, loop.id);

    expect(workerConfigs[0]?.modeId).toBe("bypassPermissions");
    expect(verifierConfigs[0]?.modeId).toBe("bypassPermissions");
  });

  test("defaults OpenCode workers and verifiers to build plus auto accept", async () => {
    class CapturingScriptedAgentClient extends ScriptedAgentClient {
      readonly createdConfigs: AgentSessionConfig[] = [];

      override async createSession(
        config: AgentSessionConfig,
        launchContext?: AgentLaunchContext,
      ): Promise<AgentSession> {
        this.createdConfigs.push(config);
        return super.createSession(config, launchContext);
      }
    }

    const opencodeClient = new CapturingScriptedAgentClient("opencode", {
      async onRun({ config }) {
        if (config.title?.includes("worker")) {
          writeFileSync(path.join(workspaceDir, "done.txt"), "ok");
          return "created done.txt";
        }
        return '{"passed":true,"reason":"ok"}';
      },
    });
    const manager = new AgentManager({
      clients: {
        opencode: opencodeClient,
      },
      registry: storage,
      logger,
    });
    const service = createLoopService({
      paseoHome,
      agentManager: manager,
      agentStorage: storage,
      logger,
      providerSnapshotManager: {
        async resolveCreateConfig(input) {
          expect(input).toMatchObject({
            parent: null,
            unattended: true,
            requestedMode: undefined,
          });
          return {
            modeId: input.unattended ? "build" : "interactive",
            featureValues: input.unattended
              ? { ...input.featureValues, auto_accept: true }
              : input.featureValues,
          };
        },
      },
    });
    await service.initialize();

    const loop = await service.runLoop({
      prompt: "Create done.txt",
      cwd: workspaceDir,
      provider: "opencode",
      model: "test-model",
      verifyPrompt: "Confirm that done.txt exists in the workspace.",
      maxIterations: 1,
    });

    await waitForLoopCompletion(service, loop.id);

    expect(opencodeClient.createdConfigs[0]).toMatchObject({
      modeId: "build",
      featureValues: { auto_accept: true },
    });
    expect(opencodeClient.createdConfigs[1]).toMatchObject({
      modeId: "build",
      featureValues: { auto_accept: true },
    });
  });

  test("explicit modeId wins over unattended default", async () => {
    const workerConfigs: AgentSessionConfig[] = [];
    const verifierConfigs: AgentSessionConfig[] = [];
    const manager = new AgentManager({
      clients: {
        claude: new ScriptedAgentClient("claude", {
          async onRun({ config }) {
            if (config.title?.includes("worker")) {
              workerConfigs.push(config);
              writeFileSync(path.join(workspaceDir, "done.txt"), "ok");
              return "created done.txt";
            }
            verifierConfigs.push(config);
            return '{"passed":true,"reason":"ok"}';
          },
        }),
      },
      registry: storage,
      logger,
    });
    const service = createLoopService({
      paseoHome,
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await service.initialize();

    const loop = await service.runLoop({
      prompt: "Create done.txt",
      cwd: workspaceDir,
      model: "test-model",
      modeId: "acceptEdits",
      verifierModeId: "plan",
      verifyPrompt: "Confirm that done.txt exists in the workspace.",
      maxIterations: 1,
    });

    await waitForLoopCompletion(service, loop.id);

    expect(workerConfigs[0]?.modeId).toBe("acceptEdits");
    expect(verifierConfigs[0]?.modeId).toBe("plan");
  });

  test("stops a running loop and cancels the active worker", async () => {
    let release: (() => void) | null = null;
    const cancelledAgentIds: string[] = [];
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new AgentManager({
      clients: {
        claude: new ScriptedAgentClient("claude", {
          async onRun({ config }) {
            if (config.title?.includes("worker")) {
              await blocker;
              return "finished";
            }
            return '{"passed":true,"reason":"ok"}';
          },
        }),
      },
      registry: storage,
      logger,
    });
    const cancelAgentRun = manager.cancelAgentRun.bind(manager);
    manager.cancelAgentRun = async (agentId) => {
      cancelledAgentIds.push(agentId);
      return cancelAgentRun(agentId);
    };
    const service = createLoopService({
      paseoHome,
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await service.initialize();

    const loop = await service.runLoop({
      prompt: "Wait forever",
      cwd: workspaceDir,
      model: "test-model",
      verifyChecks: ["test -f never.txt"],
    });

    const workerAgentId = await waitForActiveWorkerRun(service, manager, loop.id);
    const stopPromise = service.stopLoop(loop.id);
    let cancelWaitError: unknown;
    try {
      await waitForCancelledAgent(cancelledAgentIds, workerAgentId);
    } catch (error) {
      cancelWaitError = error;
    } finally {
      release?.();
    }
    const stopped = await stopPromise;
    if (cancelWaitError) {
      throw cancelWaitError;
    }

    expect(stopped.status).toBe("stopped");
    const finalLoop = await service.inspectLoop(loop.id);
    expect(finalLoop.status).toBe("stopped");
    expect(finalLoop.iterations[0]?.status).toBe("stopped");
    expect(cancelledAgentIds).toEqual([workerAgentId]);
    expect(finalLoop.logs.some((entry) => entry.text.includes("Stop requested"))).toBe(true);
  });

  test("force-closes a loop worker when graceful cancellation is refused", async () => {
    let release: (() => void) | null = null;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancelledAgentIds: string[] = [];
    const closedAgentIds: string[] = [];
    const manager = new AgentManager({
      clients: {
        claude: new ScriptedAgentClient("claude", {
          async onRun({ config }) {
            if (config.title?.includes("worker")) {
              await blocker;
              return "finished";
            }
            return '{"passed":true,"reason":"ok"}';
          },
        }),
      },
      registry: storage,
      logger,
    });
    manager.cancelAgentRun = async (agentId) => {
      cancelledAgentIds.push(agentId);
      return { status: "refused" };
    };
    const closeAgent = manager.closeAgent.bind(manager);
    manager.closeAgent = async (agentId) => {
      closedAgentIds.push(agentId);
      await closeAgent(agentId);
    };
    const service = createLoopService({
      paseoHome,
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await service.initialize();

    const loop = await service.runLoop({
      prompt: "Wait forever",
      cwd: workspaceDir,
      model: "test-model",
      verifyChecks: ["test -f never.txt"],
    });
    const workerAgentId = await waitForActiveWorkerRun(service, manager, loop.id);
    const stopPromise = service.stopLoop(loop.id);
    let closeWaitError: unknown;

    try {
      await waitForCancelledAgent(cancelledAgentIds, workerAgentId);
      await waitForCancelledAgent(closedAgentIds, workerAgentId);
    } catch (error) {
      closeWaitError = error;
    } finally {
      release?.();
    }

    const stopped = await stopPromise;
    if (closeWaitError) {
      throw closeWaitError;
    }
    expect(stopped.status).toBe("stopped");
    expect(cancelledAgentIds).toEqual([workerAgentId]);
    expect(closedAgentIds).toContain(workerAgentId);
  });

  test("tolerates a loop worker closing while graceful cancellation is refused", async () => {
    let release: (() => void) | null = null;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancelledAgentIds: string[] = [];
    const manager = new AgentManager({
      clients: {
        claude: new ScriptedAgentClient("claude", {
          async onRun({ config }) {
            if (config.title?.includes("worker")) {
              await blocker;
              return "finished";
            }
            return '{"passed":true,"reason":"ok"}';
          },
        }),
      },
      registry: storage,
      logger,
    });
    const closeAgent = manager.closeAgent.bind(manager);
    manager.cancelAgentRun = async (agentId) => {
      cancelledAgentIds.push(agentId);
      await closeAgent(agentId);
      return { status: "refused" };
    };
    const service = createLoopService({
      paseoHome,
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await service.initialize();

    const loop = await service.runLoop({
      prompt: "Finish while Stop is canceling",
      cwd: workspaceDir,
      model: "test-model",
      verifyChecks: ["test -f never.txt"],
    });
    const workerAgentId = await waitForActiveWorkerRun(service, manager, loop.id);
    const stopPromise = service.stopLoop(loop.id);

    await waitForCancelledAgent(cancelledAgentIds, workerAgentId);
    release?.();

    await expect(stopPromise).resolves.toMatchObject({ status: "stopped" });
  });

  test("reports unexpected loop worker cancellation errors", async () => {
    let release: (() => void) | null = null;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new AgentManager({
      clients: {
        claude: new ScriptedAgentClient("claude", {
          async onRun({ config }) {
            if (config.title?.includes("worker")) {
              await blocker;
              return "finished";
            }
            return '{"passed":true,"reason":"ok"}';
          },
        }),
      },
      registry: storage,
      logger,
    });
    manager.cancelAgentRun = async () => {
      throw new Error("cancellation transport failed");
    };
    const service = createLoopService({
      paseoHome,
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await service.initialize();

    const loop = await service.runLoop({
      prompt: "Fail while Stop is canceling",
      cwd: workspaceDir,
      model: "test-model",
      verifyChecks: ["test -f never.txt"],
    });
    await waitForActiveWorkerRun(service, manager, loop.id);
    const execution = (
      service as unknown as { running: Map<string, { promise: Promise<void> }> }
    ).running.get(loop.id)?.promise;

    try {
      await expect(service.stopLoop(loop.id)).rejects.toThrow("cancellation transport failed");
    } finally {
      release?.();
      await execution;
    }
  });

  test("stops while waiting for loop workspace provisioning without starting a worker", async () => {
    let resolveWorkspace: ((workspaceId: string) => void) | null = null;
    const workspaceProvisioned = new Promise<string>((resolve) => {
      resolveWorkspace = resolve;
    });
    const manager = new AgentManager({
      clients: {
        claude: new ScriptedAgentClient("claude", {
          async onRun() {
            return "worker should not start";
          },
        }),
      },
      registry: storage,
      logger,
    });
    const createAgent = manager.createAgent.bind(manager);
    let createAgentCalls = 0;
    manager.createAgent = async (...args) => {
      createAgentCalls += 1;
      return createAgent(...args);
    };
    const service = createLoopService({
      paseoHome,
      agentManager: manager,
      agentStorage: storage,
      logger,
      ensureWorkspaceForCreate: async () => workspaceProvisioned,
    });
    await service.initialize();

    const loop = await service.runLoop({
      prompt: "Stop before workspace is ready",
      cwd: workspaceDir,
      model: "test-model",
      verifyPrompt: "Should not run.",
      maxIterations: 1,
    });
    await waitForLoopIteration(service, loop.id);

    const stopPromise = service.stopLoop(loop.id);
    await waitForStopRequested(service, loop.id);
    resolveWorkspace?.("workspace-created-after-stop");
    const stopped = await stopPromise;

    expect(stopped.status).toBe("stopped");
    expect(createAgentCalls).toBe(0);
    const finalLoop = await service.inspectLoop(loop.id);
    expect(finalLoop.status).toBe("stopped");
    expect(finalLoop.activeWorkerAgentId).toBeNull();
    expect(finalLoop.iterations[0]).toMatchObject({
      workerAgentId: null,
      status: "stopped",
      failureReason: "Loop stopped",
    });
  });

  test("treats externally canceled worker turns as failures", async () => {
    let release: (() => void) | null = null;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new AgentManager({
      clients: {
        claude: new ScriptedAgentClient("claude", {
          async onRun({ config }) {
            if (config.title?.includes("worker")) {
              await blocker;
              return "finished";
            }
            return '{"passed":true,"reason":"should not verify canceled worker"}';
          },
        }),
      },
      registry: storage,
      logger,
    });
    const service = createLoopService({
      paseoHome,
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await service.initialize();

    const loop = await service.runLoop({
      prompt: "Wait until canceled",
      cwd: workspaceDir,
      model: "test-model",
      verifyPrompt: "Should not run.",
      maxIterations: 1,
    });

    const workerAgentId = await waitForActiveWorkerRun(service, manager, loop.id);
    await manager.cancelAgentRun(workerAgentId);
    release?.();
    await waitForLoopCompletion(service, loop.id);

    const finalLoop = await service.inspectLoop(loop.id);
    expect(finalLoop.status).toBe("failed");
    expect(finalLoop.iterations).toHaveLength(1);
    expect(finalLoop.iterations[0]).toMatchObject({
      workerAgentId,
      workerOutcome: "failed",
      status: "failed",
    });
    expect(finalLoop.iterations[0]?.failureReason).toContain("was canceled");
    expect(finalLoop.iterations[0]?.verifierAgentId).toBeNull();
  });
});

async function fsMkdir(target: string): Promise<void> {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(target, { recursive: true }));
}

function pathExists(target: string): boolean {
  return existsSync(target);
}

async function waitForLoopCompletion(service: LoopService, loopId: string): Promise<void> {
  while ((await service.inspectLoop(loopId)).status === "running") {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForActiveWorkerRun(
  service: LoopService,
  manager: AgentManager,
  loopId: string,
): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const loop = await service.inspectLoop(loopId);
    const workerAgentId = loop.activeWorkerAgentId;
    if (workerAgentId && manager.getAgent(workerAgentId)?.activeForegroundTurnId) {
      return workerAgentId;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for loop worker run to start");
}

async function waitForLoopIteration(service: LoopService, loopId: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const loop = await service.inspectLoop(loopId);
    if (loop.iterations.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for loop iteration to start");
}

async function waitForStopRequested(service: LoopService, loopId: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const loop = await service.inspectLoop(loopId);
    if (loop.stopRequestedAt) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for loop stop request");
}

async function waitForCancelledAgent(
  cancelledAgentIds: readonly string[],
  agentId: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (cancelledAgentIds.includes(agentId)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for loop worker cancellation");
}
