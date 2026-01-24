import { describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
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
  const logger = createTestLogger();

  test("normalizeConfig does not inject default model when omitted", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
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
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "agent-with-title",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Fix Login Bug",
    });

    expect(snapshot.id).toBe("agent-with-title");
    expect(snapshot.lifecycle).toBe("idle");

    const persisted = await storage.get("agent-with-title");
    expect(persisted?.title).toBe("Fix Login Bug");
    expect(persisted?.id).toBe("agent-with-title");
  });

  test("createAgent populates runtimeInfo after session creation", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
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
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
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

  test("listAgents excludes internal agents", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    let agentCounter = 0;
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => `agent-${agentCounter++}`,
    });

    // Create a normal agent
    await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Normal Agent",
    });

    // Create an internal agent
    await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Internal Agent",
      internal: true,
    });

    const agents = manager.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]?.config.title).toBe("Normal Agent");
  });

  test("getAgent returns internal agents by ID", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "internal-agent",
    });

    await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Internal Agent",
      internal: true,
    });

    const agent = manager.getAgent("internal-agent");
    expect(agent).not.toBeNull();
    expect(agent?.internal).toBe(true);
  });

  test("subscribe does not emit state events for internal agents to global subscribers", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    let agentCounter = 0;
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => `agent-${agentCounter++}`,
    });

    const receivedEvents: string[] = [];
    manager.subscribe((event) => {
      if (event.type === "agent_state") {
        receivedEvents.push(event.agent.id);
      }
    });

    // Create a normal agent - should emit
    await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Normal Agent",
    });

    // Create an internal agent - should NOT emit to global subscriber
    await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Internal Agent",
      internal: true,
    });

    // Should only have events from the normal agent
    expect(receivedEvents.filter((id) => id === "agent-0").length).toBeGreaterThan(0);
    expect(receivedEvents.filter((id) => id === "agent-1").length).toBe(0);
  });

  test("subscribe emits state events for internal agents when subscribed by agentId", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "internal-agent",
    });

    const receivedEvents: string[] = [];
    // Subscribe specifically to the internal agent
    manager.subscribe(
      (event) => {
        if (event.type === "agent_state") {
          receivedEvents.push(event.agent.id);
        }
      },
      { agentId: "internal-agent", replayState: false }
    );

    await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Internal Agent",
      internal: true,
    });

    // Should receive events when subscribed by specific agentId
    expect(receivedEvents.filter((id) => id === "internal-agent").length).toBeGreaterThan(0);
  });

  test("onAgentAttention is not called for internal agents", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const attentionCalls: string[] = [];
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "internal-agent",
      onAgentAttention: ({ agentId }) => {
        attentionCalls.push(agentId);
      },
    });

    const agent = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Internal Agent",
      internal: true,
    });

    // Run and complete the agent (which normally triggers attention)
    await manager.runAgent(agent.id, "hello");

    // Should NOT have triggered attention callback for internal agent
    expect(attentionCalls).toHaveLength(0);
  });
});
