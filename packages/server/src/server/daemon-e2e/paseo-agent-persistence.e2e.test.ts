import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import pino from "pino";

import { PaseoAgentSession } from "../agent/providers/paseo-agent/agent.js";
import type { PaseoAgentSessionHandle } from "../agent/providers/paseo-agent/pi-services.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  AgentSession,
  AgentSessionConfig,
  FetchCatalogOptions,
} from "../agent/agent-sdk-types.js";

const PASEO_AGENT_TEST_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  requiresPaseoTools: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

class FakeInProcessPiSession {
  readonly sessionId: string;
  readonly thinkingLevel = "medium";
  readonly model = { provider: "openrouter-main", id: "test-model" };
  readonly messages: Array<{ role: string; content: unknown; toolCallId?: string }> = [];
  readonly agent = { state: { errorMessage: "" } };
  abortCalls = 0;
  disposeCalls = 0;
  promptCalls: Array<{ text: string; options: unknown }> = [];
  private readonly subscribers = new Set<(event: AgentSessionEvent) => void>();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  subscribe(callback: (event: AgentSessionEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async prompt(text: string, options?: unknown): Promise<void> {
    this.promptCalls.push({ text, options });
    this.messages.push({ role: "user", content: text });
    setTimeout(() => {
      this.emit({ type: "agent_start" } as AgentSessionEvent);
      this.emit({ type: "turn_start" } as AgentSessionEvent);
      this.messages.push({
        role: "assistant",
        content: [{ type: "text", text: `ack: ${text}` }],
      });
      this.emit({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_delta", delta: `ack: ${text}` },
      } as AgentSessionEvent);
      this.emit({
        type: "agent_end",
        messages: this.messages,
        willRetry: false,
      } as AgentSessionEvent);
    }, 0);
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
  }

  dispose(): void {
    this.disposeCalls += 1;
  }

  getSessionStats() {
    return {
      sessionFile: undefined,
      sessionId: this.sessionId,
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      cost: 0,
      contextUsage: { contextWindow: 200000, tokens: 2, percentage: 0.01 },
    };
  }

  setThinkingLevel(): void {}

  async setModel(): Promise<void> {}

  private emit(event: AgentSessionEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}

class RecordingPaseoAgentClient implements AgentClient {
  readonly provider = "paseo";
  readonly capabilities = PASEO_AGENT_TEST_CAPABILITIES;
  readonly createdConfigs: AgentSessionConfig[] = [];
  private nextSessionOrdinal = 0;

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.createdConfigs.push(config);
    this.nextSessionOrdinal += 1;
    const fakePi = new FakeInProcessPiSession(`fake-paseo-session-${this.nextSessionOrdinal}`);
    const handle = {
      session: fakePi,
      modelRegistry: { find: () => fakePi.model },
      resourceLoader: {},
      sessionManager: {},
    } as unknown as PaseoAgentSessionHandle;
    const mcpBridge = {
      tools: [],
      async close() {},
    };
    return new PaseoAgentSession(handle, config, mcpBridge, null, []);
  }

  async resumeSession(): Promise<AgentSession> {
    throw new Error("test Paseo Agent client does not support resume");
  }

  async fetchCatalog(_options: FetchCatalogOptions): Promise<{
    models: AgentModelDefinition[];
    modes: AgentMode[];
  }> {
    return {
      models: [
        {
          provider: "paseo",
          id: "openrouter-main/test-model",
          label: "Test Model",
          isDefault: true,
        },
      ],
      modes: [],
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function textTimelineItems(
  entries: ReadonlyArray<{ item: { type: string; text?: string; messageId?: string } }>,
) {
  return entries
    .filter(
      (entry) => entry.item.type === "user_message" || entry.item.type === "assistant_message",
    )
    .map((entry) => entry.item);
}

describe("daemon E2E - Paseo Agent persistence", () => {
  const tempDirs: string[] = [];
  let daemon: TestPaseoDaemon | undefined;
  let client: DaemonClient | undefined;

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    client = undefined;
    daemon = undefined;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("Paseo Agent user messages survive a client refresh and agent reload", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "paseo-agent-persist-cwd-"));
    tempDirs.push(cwd);
    const paseo = new RecordingPaseoAgentClient();
    daemon = await createTestPaseoDaemon({
      agentClients: { paseo },
      logger: pino({ level: "silent" }),
    });
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.1.70",
    });
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "paseo-agent-persistence-test" } });

    const agent = await client.createAgent({ provider: "paseo", cwd });
    await client.sendMessage(agent.id, "hello from the user", { messageId: "client-message-1" });
    await client.waitForFinish(agent.id, 5_000);

    await client.close();
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.1.70",
    });
    await client.connect();
    await client.fetchAgents({
      subscribe: { subscriptionId: "paseo-agent-persistence-refresh-test" },
    });

    const afterClientRefresh = await client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    expect(textTimelineItems(afterClientRefresh.entries)).toEqual([
      { type: "user_message", text: "hello from the user", messageId: "client-message-1" },
      { type: "assistant_message", text: "ack: hello from the user" },
    ]);

    await client.refreshAgent(agent.id);
    const afterAgentReload = await client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    expect(textTimelineItems(afterAgentReload.entries)).toEqual([
      { type: "user_message", text: "hello from the user", messageId: "client-message-1" },
      { type: "assistant_message", text: "ack: hello from the user" },
    ]);
  }, 30_000);

  test("Paseo Agent gets the internal Paseo MCP server when global tool injection is off", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "paseo-agent-tools-cwd-"));
    tempDirs.push(cwd);
    const paseo = new RecordingPaseoAgentClient();
    daemon = await createTestPaseoDaemon({
      agentClients: { paseo },
      mcpInjectIntoAgents: false,
      logger: pino({ level: "silent" }),
    });
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.1.70",
    });
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "paseo-agent-tools-test" } });

    const agent = await client.createAgent({ provider: "paseo", cwd });

    expect(paseo.createdConfigs.at(-1)?.mcpServers?.paseo).toMatchObject({
      type: "http",
      url: `http://127.0.0.1:${daemon.port}/mcp/agents?callerAgentId=${agent.id}`,
    });
    expect(daemon.daemon.agentManager.getAgent(agent.id)?.config.mcpServers?.paseo).toBeUndefined();
  }, 30_000);
});
