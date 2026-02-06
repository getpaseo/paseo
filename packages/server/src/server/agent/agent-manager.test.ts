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

  async isAvailable(): Promise<boolean> {
    return true;
  }

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
      idFactory: () => "00000000-0000-4000-8000-000000000101",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    expect(snapshot.model).toBeUndefined();
  });

  test("createAgent fails when cwd does not exist", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
    });

    await expect(
      manager.createAgent({
        provider: "codex",
        cwd: join(workdir, "does-not-exist"),
      })
    ).rejects.toThrow("Working directory does not exist");
  });

  test("createAgent fails when generated agent ID is not a UUID", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "not-a-uuid",
    });

    await expect(
      manager.createAgent({
        provider: "codex",
        cwd: workdir,
      })
    ).rejects.toThrow("createAgent: agentId must be a UUID");
  });

  test("createAgent fails when explicit agent ID is not a UUID", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
    });

    await expect(
      manager.createAgent(
        {
          provider: "codex",
          cwd: workdir,
        },
        "not-a-uuid"
      )
    ).rejects.toThrow("createAgent: agentId must be a UUID");
  });

  test("createAgent persists provided title before returning", async () => {
    const agentId = "00000000-0000-4000-8000-000000000102";
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => agentId,
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Fix Login Bug",
    });

    expect(snapshot.id).toBe(agentId);
    expect(snapshot.lifecycle).toBe("idle");

    const persisted = await storage.get(agentId);
    expect(persisted?.title).toBe("Fix Login Bug");
    expect(persisted?.id).toBe(agentId);
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
      idFactory: () => "00000000-0000-4000-8000-000000000103",
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
      idFactory: () => "00000000-0000-4000-8000-000000000104",
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
    const generatedAgentIds = [
      "00000000-0000-4000-8000-000000000105",
      "00000000-0000-4000-8000-000000000106",
    ];
    let agentCounter = 0;
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => generatedAgentIds[agentCounter++] ?? randomUUID(),
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
    const internalAgentId = "00000000-0000-4000-8000-000000000107";
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => internalAgentId,
    });

    await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Internal Agent",
      internal: true,
    });

    const agent = manager.getAgent(internalAgentId);
    expect(agent).not.toBeNull();
    expect(agent?.internal).toBe(true);
  });

  test("subscribe does not emit state events for internal agents to global subscribers", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const generatedAgentIds = [
      "00000000-0000-4000-8000-000000000108",
      "00000000-0000-4000-8000-000000000109",
    ];
    let agentCounter = 0;
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => generatedAgentIds[agentCounter++] ?? randomUUID(),
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
    expect(receivedEvents.filter((id) => id === generatedAgentIds[0]).length).toBeGreaterThan(0);
    expect(receivedEvents.filter((id) => id === generatedAgentIds[1]).length).toBe(0);
  });

  test("subscribe emits state events for internal agents when subscribed by agentId", async () => {
    const internalAgentId = "00000000-0000-4000-8000-000000000110";
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => internalAgentId,
    });

    const receivedEvents: string[] = [];
    // Subscribe specifically to the internal agent
    manager.subscribe(
      (event) => {
        if (event.type === "agent_state") {
          receivedEvents.push(event.agent.id);
        }
      },
      { agentId: internalAgentId, replayState: false }
    );

    await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Internal Agent",
      internal: true,
    });

    // Should receive events when subscribed by specific agentId
    expect(receivedEvents.filter((id) => id === internalAgentId).length).toBeGreaterThan(0);
  });

  test("subscribe fails when filter agentId is not a UUID", () => {
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      logger,
    });

    expect(() =>
      manager.subscribe(() => {}, {
        agentId: "invalid-agent-id",
      })
    ).toThrow("subscribe: agentId must be a UUID");
  });

  test("onAgentAttention is not called for internal agents", async () => {
    const internalAgentId = "00000000-0000-4000-8000-000000000111";
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
      idFactory: () => internalAgentId,
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

  test("respondToPermission updates currentModeId after plan approval", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    // Create a session that simulates plan approval mode change
    let sessionMode = "plan";
    class PlanModeTestSession implements AgentSession {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;
      readonly id = randomUUID();

      async run(): Promise<AgentRunResult> {
        return { sessionId: this.id, finalText: "", timeline: [] };
      }

      async *stream(): AsyncGenerator<AgentStreamEvent> {
        yield { type: "turn_started", provider: this.provider };
        yield { type: "turn_completed", provider: this.provider };
      }

      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

      async getRuntimeInfo() {
        return { provider: this.provider, sessionId: this.id, model: null, modeId: sessionMode };
      }

      async getAvailableModes() {
        return [
          { id: "plan", label: "Plan" },
          { id: "acceptEdits", label: "Accept Edits" },
        ];
      }

      async getCurrentMode() {
        return sessionMode;
      }

      async setMode(modeId: string): Promise<void> {
        sessionMode = modeId;
      }

      getPendingPermissions() {
        return [];
      }

      async respondToPermission(
        _requestId: string,
        response: { behavior: string }
      ): Promise<void> {
        // Simulate what claude-agent.ts does: when plan permission is approved,
        // it calls setMode("acceptEdits") internally
        if (response.behavior === "allow") {
          sessionMode = "acceptEdits";
        }
      }

      describePersistence() {
        return { provider: this.provider, sessionId: this.id };
      }

      async interrupt(): Promise<void> {}
      async close(): Promise<void> {}
    }

    class PlanModeTestClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;

      async isAvailable(): Promise<boolean> {
        return true;
      }

      async createSession(): Promise<AgentSession> {
        return new PlanModeTestSession();
      }

      async resumeSession(): Promise<AgentSession> {
        return new PlanModeTestSession();
      }
    }

    const manager = new AgentManager({
      clients: {
        codex: new PlanModeTestClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000112",
    });

    // Create agent in plan mode
    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      modeId: "plan",
    });

    expect(snapshot.currentModeId).toBe("plan");

    // Simulate a pending plan permission request
    const agent = manager.getAgent(snapshot.id)!;
    const permissionRequest = {
      id: "perm-123",
      provider: "codex" as const,
      name: "ExitPlanMode",
      kind: "plan" as const,
      input: { plan: "Test plan" },
    };
    agent.pendingPermissions.set(permissionRequest.id, permissionRequest);

    // Approve the plan permission
    await manager.respondToPermission(snapshot.id, "perm-123", {
      behavior: "allow",
    });

    // The session's mode has changed to "acceptEdits" internally
    // The manager should have updated currentModeId to reflect this
    const updatedAgent = manager.getAgent(snapshot.id);
    expect(updatedAgent?.currentModeId).toBe("acceptEdits");
  });

  test("close during in-flight stream does not clear persistence sessionId", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    class CloseRaceSession implements AgentSession {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;
      readonly id = randomUUID();
      private threadId: string | null = this.id;
      private releaseStream: (() => void) | null = null;
      private closed = false;

      async run(): Promise<AgentRunResult> {
        return { sessionId: this.id, finalText: "", timeline: [] };
      }

      async *stream(): AsyncGenerator<AgentStreamEvent> {
        yield { type: "turn_started", provider: this.provider };
        if (!this.closed) {
          await new Promise<void>((resolve) => {
            this.releaseStream = resolve;
          });
        }
        yield { type: "turn_canceled", provider: this.provider, reason: "closed" };
      }

      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

      async getRuntimeInfo() {
        return {
          provider: this.provider,
          sessionId: this.threadId,
          model: null,
          modeId: null,
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
        if (!this.threadId) {
          return null;
        }
        return { provider: this.provider, sessionId: this.threadId };
      }

      async interrupt(): Promise<void> {}

      async close(): Promise<void> {
        this.closed = true;
        this.threadId = null;
        this.releaseStream?.();
      }
    }

    class CloseRaceClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;

      async isAvailable(): Promise<boolean> {
        return true;
      }

      async createSession(): Promise<AgentSession> {
        return new CloseRaceSession();
      }

      async resumeSession(): Promise<AgentSession> {
        return new CloseRaceSession();
      }
    }

    const manager = new AgentManager({
      clients: {
        codex: new CloseRaceClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000113",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    const stream = manager.streamAgent(snapshot.id, "hello");
    await stream.next();

    await manager.closeAgent(snapshot.id);

    // Drain stream finalizer path after close().
    while (true) {
      const next = await stream.next();
      if (next.done) {
        break;
      }
    }

    await manager.flush();
    await storage.flush();

    const persisted = await storage.get(snapshot.id);
    expect(persisted?.persistence?.sessionId).toBe(snapshot.persistence?.sessionId);
  });
});
