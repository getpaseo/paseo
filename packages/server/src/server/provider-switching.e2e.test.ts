import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import {
  AgentProviderSwitchError,
  DaemonClient,
  type WebSocketLike,
} from "@getpaseo/client/internal/daemon-client";
import { WebSocket } from "ws";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import type {
  AgentClient,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProvider,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent/agent-sdk-types.js";
import { renderProviderPromptText } from "./agent/provider-switch/index.js";

const CAPS = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
  supportsRewindConversation: true,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
} as const;

class E2EFakeSession implements AgentSession {
  readonly capabilities = CAPS;
  readonly receivedPrompts: AgentPromptInput[] = [];
  private listeners = new Set<(event: AgentStreamEvent) => void>();
  private turnCount = 0;

  constructor(
    readonly id: string,
    readonly provider: AgentProvider,
    private persistence: AgentPersistenceHandle | null,
    private readonly onStartTurn?: () => void,
  ) {}

  subscribe(listener: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    this.receivedPrompts.push(prompt);
    this.onStartTurn?.();
    this.turnCount += 1;
    const turnId = `${this.provider}-t${this.turnCount}`;
    const msgId = `${this.provider}-m${this.turnCount}`;
    const rendered = renderProviderPromptText(prompt);
    queueMicrotask(() => {
      for (const listener of this.listeners) {
        if (options?.clientMessageId) {
          listener({
            type: "timeline",
            provider: this.provider,
            turnId,
            item: {
              type: "user_message",
              text: rendered,
              messageId: msgId,
              clientMessageId: options.clientMessageId,
            },
          });
        }
        listener({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: {
            type: "assistant_message",
            text: `${this.provider} reply ${this.turnCount}`,
          },
        });
        listener({ type: "turn_completed", provider: this.provider, turnId });
      }
    });
    return { turnId };
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    await this.startTurn(prompt, options);
    return { sessionId: this.id, finalText: "", timeline: [] };
  }
  async *stream(): AsyncGenerator<AgentStreamEvent> {}
  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}
  async interrupt(): Promise<void> {}
  async getAvailableModes() {
    return [];
  }
  async getCurrentMode() {
    return null;
  }
  async setMode() {}
  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.persistence?.sessionId ?? null };
  }
  describePersistence(): AgentPersistenceHandle | null {
    return this.persistence;
  }
  async close(): Promise<void> {}
}

class E2EFakeClient implements AgentClient {
  readonly capabilities = CAPS;
  readonly sessions: E2EFakeSession[] = [];
  failNextTurn: Error | null = null;

  constructor(
    readonly provider: AgentProvider,
    private readonly initialPersistenceNull = false,
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }
  async fetchCatalog() {
    return { models: [], modes: [] };
  }
  async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
    const id = `${this.provider}-s${this.sessions.length + 1}`;
    const session = new E2EFakeSession(
      id,
      this.provider,
      this.initialPersistenceNull ? null : { provider: this.provider, sessionId: id },
      () => {
        if (this.failNextTurn) {
          const err = this.failNextTurn;
          this.failNextTurn = null;
          throw err;
        }
      },
    );
    this.sessions.push(session);
    return session;
  }
  async resumeSession(handle: AgentPersistenceHandle): Promise<AgentSession> {
    const session = new E2EFakeSession(handle.sessionId, this.provider, handle);
    this.sessions.push(session);
    return session;
  }
}

async function connectClient(
  url: string,
  capabilities?: Record<string, boolean>,
): Promise<{ client: DaemonClient; messages: SessionOutboundMessage[] }> {
  const messages: SessionOutboundMessage[] = [];
  const client = new DaemonClient({
    url,
    clientId: randomUUID(),
    webSocketFactory: (wsUrl) => new WebSocket(wsUrl) as unknown as WebSocketLike,
    reconnect: { enabled: false },
    ...(capabilities ? { capabilities } : {}),
  });
  client.subscribeRawMessages((msg) => {
    messages.push(msg);
  });
  await client.connect();
  onTestFinished(async () => {
    await client.close().catch(() => undefined);
  });
  return { client, messages };
}

describe("Provider switching WebSocket RPC, receipts, and capability gating", () => {
  let daemon: TestPaseoDaemon | null = null;

  afterEach(async () => {
    await daemon?.close();
    daemon = null;
  });

  it("handles switch RPC, idempotent retry, post-commit start failure, and gates provider_switch items for legacy clients", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "paseo-e2e-switch-"));
    onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));

    const claude = new E2EFakeClient("claude");
    const codex = new E2EFakeClient("codex", true);
    daemon = await createTestPaseoDaemon({
      agentClients: { claude, codex },
    });

    const wsUrl = `ws://127.0.0.1:${daemon.port}/ws`;
    const modern = await connectClient(wsUrl);
    const legacy = await connectClient(wsUrl, {
      [CLIENT_CAPS.timelineProviderSwitches]: false,
      [CLIENT_CAPS.timelineRewindOperations]: true,
      [CLIENT_CAPS.selectiveAgentTimeline]: true,
    });

    // Server advertises providerSwitching feature
    const serverInfoMsg = modern.messages.find(
      (m) => m.type === "status" && m.payload.status === "server_info",
    );
    expect(
      serverInfoMsg &&
        serverInfoMsg.type === "status" &&
        serverInfoMsg.payload.status === "server_info"
        ? serverInfoMsg.payload.features?.providerSwitching
        : undefined,
    ).toBe(true);

    const agent = await modern.client.createAgent({ provider: "claude", cwd });
    await modern.client.sendMessage(agent.id, "First message on Claude", undefined, {
      messageId: "msg-c1",
    });

    // Wait briefly for turn 1 to settle
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Switch from Claude to Codex via RPC
    const switched = await modern.client.switchAgentProvider(agent.id, {
      provider: "codex",
      text: "Continue on Codex",
      messageId: "msg-sw-1",
    });
    expect(switched.agent?.provider).toBe("codex");
    expect(switched.agent?.id).toBe(agent.id);

    // Wait for Codex turn 1 to settle
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Idempotent retry with same messageId + same payload succeeds and returns current agent without creating a 2nd session
    const retried = await modern.client.switchAgentProvider(agent.id, {
      provider: "codex",
      text: "Continue on Codex",
      messageId: "msg-sw-1",
    });
    expect(retried.agent?.provider).toBe("codex");
    expect(codex.sessions).toHaveLength(1);

    // Modern client sees provider_switch item + activeSegmentStartSeq > 0
    const modernPage = await modern.client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 50,
    });
    expect(modernPage.activeSegmentStartSeq).toBeGreaterThan(0);
    expect(modernPage.entries.some((e) => e.item.type === "provider_switch")).toBe(true);
    // Ensure providerPromptText is NEVER leaked on wire entries
    for (const entry of modernPage.entries) {
      expect("providerPromptText" in entry).toBe(false);
    }

    // Legacy client WITHOUT timeline_provider_switches NEVER receives provider_switch items!
    const legacyPage = await legacy.client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 50,
    });
    expect(legacyPage.entries.some((e) => e.item.type === "provider_switch")).toBe(false);
    expect(legacyPage.entries.filter((e) => e.item.type === "user_message")).toHaveLength(2);

    // Post-commit start failure: switch back to Claude, but fail turn 1 startTurn
    claude.failNextTurn = new Error("Claude rate limited on turn 1");
    let caught: unknown;
    try {
      await modern.client.switchAgentProvider(agent.id, {
        provider: "claude",
        text: "Back to Claude",
        messageId: "msg-sw-2",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentProviderSwitchError);
    const switchErr = caught as AgentProviderSwitchError;
    expect(switchErr.message).toContain("Claude rate limited on turn 1");
    // Response MUST include committed Claude agent snapshot so UI updates live provider and lets user retry normally!
    expect(switchErr.agent?.provider).toBe("claude");
    expect(switchErr.agent?.id).toBe(agent.id);
  });
});
