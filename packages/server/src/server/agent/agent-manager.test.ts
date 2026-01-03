import { describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { AgentManager } from "./agent-manager.js";
import { AgentRegistry } from "./agent-registry.js";
import type {
  AgentClient,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

const TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

class TestAgentClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return new TestAgentSession(config);
  }

  async resumeSession(config?: Partial<AgentSessionConfig>): Promise<AgentSession> {
    return new TestAgentSession({
      provider: "codex",
      cwd: config?.cwd ?? process.cwd(),
    });
  }
}

class TestAgentSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly id = randomUUID();
  private runtimeModel: string | null = null;

  constructor(private readonly config: AgentSessionConfig) {}

  async run(): Promise<AgentRunResult> {
    return {
      sessionId: this.id ?? this.config.provider,
      finalText: "",
      timeline: [],
    };
  }

  async *stream(): AsyncGenerator<AgentStreamEvent> {
    yield { type: "turn_started", provider: this.provider };
    yield { type: "turn_completed", provider: this.provider };
    this.runtimeModel = "gpt-5.2-codex";
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.runtimeModel ?? this.config.model ?? null,
      modeId: this.config.modeId ?? null,
    };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence() {
    return {
      provider: this.provider,
      sessionId: this.id,
    };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

describe("AgentManager", () => {
  test("normalizeConfig does not inject default model when omitted", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const registryPath = join(workdir, "agents.json");
    const registry = new AgentRegistry(registryPath);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry,
      idFactory: () => "agent-without-model",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    expect(snapshot.model).toBeUndefined();
  });

  test("createAgent persists provided title before returning", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const registryPath = join(workdir, "agents.json");
    const registry = new AgentRegistry(registryPath);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry,
      idFactory: () => "agent-with-title",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Fix Login Bug",
    });

    expect(snapshot.id).toBe("agent-with-title");
    expect(snapshot.lifecycle).toBe("idle");

    const persisted = await registry.get("agent-with-title");
    expect(persisted?.title).toBe("Fix Login Bug");
    expect(persisted?.id).toBe("agent-with-title");
  });

  test("createAgent populates runtimeInfo after session creation", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const registryPath = join(workdir, "agents.json");
    const registry = new AgentRegistry(registryPath);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry,
      idFactory: () => "agent-with-runtime-info",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      model: "gpt-5.2-codex",
      modeId: "full-access",
    });

    expect(snapshot.runtimeInfo).toBeDefined();
    expect(snapshot.runtimeInfo?.model).toBe("gpt-5.2-codex");
    expect(snapshot.runtimeInfo?.sessionId).toBe(snapshot.persistence?.sessionId);
  });

  test("runAgent refreshes runtimeInfo after completion", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const registryPath = join(workdir, "agents.json");
    const registry = new AgentRegistry(registryPath);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry,
      idFactory: () => "agent-with-run-runtime",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    expect(snapshot.runtimeInfo?.model ?? null).toBeNull();

    await manager.runAgent(snapshot.id, "hello");

    const refreshed = manager.getAgent(snapshot.id);
    expect(refreshed?.runtimeInfo?.model).toBe("gpt-5.2-codex");
  });
});
