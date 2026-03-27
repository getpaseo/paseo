import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
} from "./agent/agent-sdk-types.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { AgentManager } from "./agent/agent-manager.js";
import { LoopService } from "./loop-service.js";
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
  readonly provider = "claude" as const;
  readonly capabilities = TEST_CAPABILITIES;

  constructor(private readonly behavior: ScriptedAgentBehavior) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(
    config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    return new ScriptedAgentSession(config, this.behavior);
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    return new ScriptedAgentSession(
      {
        provider: "claude",
        cwd: overrides?.cwd ?? process.cwd(),
        ...overrides,
      },
      this.behavior,
    );
  }

  async listModels(_options?: ListModelsOptions): Promise<AgentModelDefinition[]> {
    return [];
  }
}

class ScriptedAgentSession implements AgentSession {
  readonly provider = "claude" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly id = randomUUID();
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turnCount = 0;
  private interrupted = false;

  constructor(
    private readonly config: AgentSessionConfig,
    private readonly behavior: ScriptedAgentBehavior,
  ) {}

  async run(): Promise<AgentRunResult> {
    return {
      sessionId: this.id,
      finalText: "",
      timeline: [],
    };
  }

  async startTurn(prompt: AgentPromptInput, _options?: AgentRunOptions): Promise<{ turnId: string }> {
    const promptText = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
    const turnId = `turn-${++this.turnCount}`;
    this.interrupted = false;
    setTimeout(() => {
      void this.runScript(promptText, turnId);
    }, 0);
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
        this.emit({ type: "turn_canceled", provider: this.provider, reason: "interrupted", turnId });
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
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "loop-service-"));
    paseoHome = path.join(tmpDir, "paseo-home");
    workspaceDir = path.join(tmpDir, "workspace");
    storage = new AgentStorage(path.join(tmpDir, "agents"), logger);
    mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("runs fresh worker agents until verify-check passes", async () => {
    const state = { workerRuns: 0 };
    const manager = new AgentManager({
      clients: {
        claude: new ScriptedAgentClient({
          async onRun({ config }) {
            state.workerRuns += 1;
            if (config.title?.includes("worker") && state.workerRuns >= 2) {
              writeFileSync(path.join(workspaceDir, "done.txt"), "ok");
            }
            if (config.title?.includes("worker")) {
              return `worker run ${state.workerRuns}`;
            }
            return "{\"passed\":true,\"reason\":\"not used\"}";
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
      verifyChecks: ["test -f done.txt"],
      sleepMs: 1,
      maxIterations: 3,
    });

    while ((await service.inspectLoop(loop.id)).status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const finalLoop = await service.inspectLoop(loop.id);
    expect(finalLoop.status).toBe("succeeded");
    expect(finalLoop.iterations).toHaveLength(2);
    expect(finalLoop.iterations[0]?.workerAgentId).not.toBe(finalLoop.iterations[1]?.workerAgentId);
    expect(finalLoop.iterations[0]?.status).toBe("failed");
    expect(finalLoop.iterations[1]?.status).toBe("succeeded");
    expect(finalLoop.iterations[0]?.verifyChecks[0]?.passed).toBe(false);
    expect(finalLoop.iterations[1]?.verifyChecks[0]?.passed).toBe(true);
    expect(readFileSync(path.join(paseoHome, "loops", "loops.json"), "utf8")).toContain(loop.id);
  });

  test("uses verifier prompt when provided", async () => {
    const manager = new AgentManager({
      clients: {
        claude: new ScriptedAgentClient({
          async onRun({ config }) {
            if (config.title?.includes("worker")) {
              await fsMkdir(workspaceDir);
              writeFileSync(path.join(workspaceDir, "done.txt"), "ok");
              return "created done.txt";
            }
            const exists = pathExists(path.join(workspaceDir, "done.txt"));
            return exists
              ? "{\"passed\":true,\"reason\":\"done.txt exists\"}"
              : "{\"passed\":false,\"reason\":\"done.txt missing\"}";
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

    while ((await service.inspectLoop(loop.id)).status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const finalLoop = await service.inspectLoop(loop.id);
    expect(finalLoop.status).toBe("succeeded");
    expect(finalLoop.iterations[0]?.verifyPrompt).toMatchObject({
      passed: true,
      reason: "done.txt exists",
    });
    const logs = await service.getLoopLogs(loop.id);
    expect(logs.entries.some((entry) => entry.text.includes("Verifier result"))).toBe(true);
  });

  test("stops a running loop and cancels the active worker", async () => {
    let release: (() => void) | null = null;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new AgentManager({
      clients: {
        claude: new ScriptedAgentClient({
          async onRun({ config }) {
            if (config.title?.includes("worker")) {
              await blocker;
              return "finished";
            }
            return "{\"passed\":true,\"reason\":\"ok\"}";
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
