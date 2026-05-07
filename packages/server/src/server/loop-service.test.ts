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
  ListModelsOptions,
  AgentProvider,
} from "./agent/agent-sdk-types.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { AgentManager } from "./agent/agent-manager.js";
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

  async listModels(_options?: ListModelsOptions): Promise<AgentModelDefinition[]> {
    return [];
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
      const service = new LoopService({ paseoHome, agentManager: manager, logger });
      await service.initialize();

      const loop = await service.runLoop({
        prompt: "Create done.txt when the task is actually fixed.",
        cwd: workspaceDir,
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
    const service = new LoopService({ paseoHome, agentManager: manager, logger });
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
      internal: true,
    });
    expect(verifierConfigs).toHaveLength(1);
    expect(verifierConfigs[0]).toMatchObject({
      provider: "claude",
      model: "sonnet",
      internal: true,
    });
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
    const service = new LoopService({ paseoHome, agentManager: manager, logger });
    await service.initialize();

    const loop = await service.runLoop({
      prompt: "Create done.txt",
      cwd: workspaceDir,
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
    const service = new LoopService({ paseoHome, agentManager: manager, logger });
    await service.initialize();

    const loop = await service.runLoop({
      prompt: "Create done.txt",
      cwd: workspaceDir,
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
    const service = new LoopService({ paseoHome, agentManager: manager, logger });
    await service.initialize();

    const loop = await service.runLoop({
      prompt: "Create done.txt",
      cwd: workspaceDir,
      verifyPrompt: "Confirm that done.txt exists in the workspace.",
      maxIterations: 1,
    });

    await waitForLoopCompletion(service, loop.id);

    expect(workerConfigs[0]?.modeId).toBe("bypassPermissions");
    expect(verifierConfigs[0]?.modeId).toBe("bypassPermissions");
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
    const service = new LoopService({ paseoHome, agentManager: manager, logger });
    await service.initialize();

    const loop = await service.runLoop({
      prompt: "Create done.txt",
      cwd: workspaceDir,
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
    const service = new LoopService({ paseoHome, agentManager: manager, logger });
    await service.initialize();

    const loop = await service.runLoop({
      prompt: "Wait forever",
      cwd: workspaceDir,
      verifyChecks: ["test -f never.txt"],
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    const stopped = await service.stopLoop(loop.id);
    release?.();

    expect(stopped.status).toBe("stopped");
    const finalLoop = await service.inspectLoop(loop.id);
    expect(finalLoop.status).toBe("stopped");
    expect(finalLoop.iterations[0]?.status).toBe("stopped");
    expect(finalLoop.logs.some((entry) => entry.text.includes("Stop requested"))).toBe(true);
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
