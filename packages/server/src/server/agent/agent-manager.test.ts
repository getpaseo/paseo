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

  constructor(private readonly config: AgentSessionConfig) {}

  async run(): Promise<AgentRunResult> {
    return {
      sessionId: this.id ?? this.config.provider,
      finalText: "",
      timeline: [],
    };
  }

  async *stream(): AsyncGenerator<AgentStreamEvent> {}

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

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
    return null;
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

describe("AgentManager", () => {
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
});
