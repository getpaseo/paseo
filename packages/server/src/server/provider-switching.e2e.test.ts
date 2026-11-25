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
  readonly setModelCalls: Array<string | null> = [];
  closed = false;
  private listeners = new Set<(event: AgentStreamEvent) => void>();
  private turnCount = 0;

  constructor(
    readonly id: string,
    readonly provider: AgentProvider,
    private persistence: AgentPersistenceHandle | null,
    private readonly onStartTurn?: () => void,
    private readonly getTurnCompletionGate?: () => Promise<void> | null,
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
    const completionGate = this.getTurnCompletionGate?.() ?? null;
    const replyNumber = this.turnCount;
    const emitCompletion = () => {
      if (this.closed) return;
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
            text: `${this.provider} reply ${replyNumber}`,
          },
        });
        listener({ type: "turn_completed", provider: this.provider, turnId });
      }
    };
    if (completionGate) {
      void completionGate.then(emitCompletion);
    } else {
      queueMicrotask(emitCompletion);
    }
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
  async setModel(modelId: string | null) {
    this.setModelCalls.push(modelId);
    return modelId ? { model: modelId } : undefined;
  }
  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.persistence?.sessionId ?? null };
  }
  describePersistence(): AgentPersistenceHandle | null {
    return this.persistence;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  async revertConversation(): Promise<{ kind: "at_target" }> {
    return { kind: "at_target" };
  }
}

class E2EFakeClient implements AgentClient {
  readonly capabilities = CAPS;
  readonly sessions: E2EFakeSession[] = [];
  failNextCreate: Error | null = null;
  failNextTurn: Error | null = null;
  availabilityGate: Promise<void> | null = null;
  onAvailabilityCheckStarted: (() => void) | null = null;
  createSessionGate: Promise<void> | null = null;
  onCreateSessionStarted: (() => void) | null = null;
  turnCompletionGate: Promise<void> | null = null;
  onTurnStarted: (() => void) | null = null;

  constructor(
    readonly provider: AgentProvider,
    private readonly initialPersistenceNull = false,
  ) {}

  async isAvailable(): Promise<boolean> {
    this.onAvailabilityCheckStarted?.();
    if (this.availabilityGate) {
      const gate = this.availabilityGate;
      this.availabilityGate = null;
      await gate;
    }
    return true;
  }
  async fetchCatalog() {
    return { models: [], modes: [] };
  }
  async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
    this.onCreateSessionStarted?.();
    if (this.createSessionGate) {
      const gate = this.createSessionGate;
      this.createSessionGate = null;
      await gate;
    }
    if (this.failNextCreate) {
      const err = this.failNextCreate;
      this.failNextCreate = null;
      throw err;
    }
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
        this.onTurnStarted?.();
      },
      () => this.turnCompletionGate,
    );
    this.sessions.push(session);
    return session;
  }
  async resumeSession(handle: AgentPersistenceHandle): Promise<AgentSession> {
    const session = new E2EFakeSession(
      handle.sessionId,
      this.provider,
      handle,
      () => this.onTurnStarted?.(),
      () => this.turnCompletionGate,
    );
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

    // Pre-commit failure MUST NOT leave a pending receipt, so retrying the same messageId succeeds!
    codex.failNextCreate = new Error("Codex failed to open session");
    await expect(
      modern.client.switchAgentProvider(agent.id, {
        provider: "codex",
        text: "Continue on Codex",
        messageId: "msg-sw-1",
      }),
    ).rejects.toThrow("Codex failed to open session");

    // Switch from Claude to Codex via RPC reusing the exact same messageId
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

  it("delivers the original switch request after a restart between switch commit and dispatch, and keeps archived switched chats archived when resuming a prior native handle", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "paseo-provider-switch-recovery-e2e-"));
    onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));

    const claude = new E2EFakeClient("claude");
    const codex = new E2EFakeClient("codex", true);
    daemon = await createTestPaseoDaemon({
      agentClients: { claude, codex },
    });

    const url = `ws://127.0.0.1:${daemon.port}/ws`;
    const clientConn = await connectClient(url);

    // 1. Create Claude chat and save its native persistence handle.
    const created = await clientConn.client.createAgent({ provider: "claude", cwd });
    await clientConn.client.sendMessage(created.id, "First Claude turn", undefined, {
      messageId: "msg-r1",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const storedBefore = await daemon.daemon.agentStorage.get(created.id);
    expect(storedBefore?.persistence).toBeTruthy();
    const savedClaudeHandle = storedBefore!.persistence!;

    // 2. Simulate switch committed to SQLite + storage BEFORE MessageReceipts wrote pending / before dispatch,
    //    followed by daemon closing the live agent (restart boundary).
    await daemon.daemon.agentManager.switchAgentProvider(created.id, {
      toProvider: "codex",
      prompt: "Deliver after restart",
      messageId: "msg-r-sw",
    });
    await daemon.daemon.agentManager.closeAgent(created.id);

    // Client replays the EXACT SAME switchAgentProvider request after restart -> must succeed
    // without "already using provider" and without adding a second provider_switch marker!
    const replayed = await clientConn.client.switchAgentProvider(created.id, {
      provider: "codex",
      text: "Deliver after restart",
      messageId: "msg-r-sw",
    });
    expect(replayed.agent?.provider).toBe("codex");
    await new Promise((resolve) => setTimeout(resolve, 100));

    const timeline = await clientConn.client.fetchAgentTimeline(created.id, {
      direction: "tail",
      limit: 50,
    });
    expect(timeline.entries.filter((e) => e.item.type === "provider_switch")).toHaveLength(1);
    expect(
      timeline.entries.some(
        (e) => e.item.type === "user_message" && e.item.text === "Deliver after restart",
      ),
    ).toBe(true);

    // 3. Archive the switched Codex chat, then resume the saved prior Claude handle ->
    //    must NOT unarchive the separate Codex chat!
    await clientConn.client.archiveAgent(created.id);
    const archivedBeforeResume = await daemon.daemon.agentStorage.get(created.id);
    expect(archivedBeforeResume?.archivedAt).toBeTruthy();

    const resumedClaude = await clientConn.client.resumeAgent(
      {
        provider: savedClaudeHandle.provider,
        sessionId: savedClaudeHandle.sessionId,
      },
      { cwd },
    );
    expect(resumedClaude.id).not.toBe(created.id);
    expect(resumedClaude.provider).toBe("claude");

    const codexRecordAfterResume = await daemon.daemon.agentStorage.get(created.id);
    expect(codexRecordAfterResume?.archivedAt).toBeTruthy();
  });

  it("rejects an overlapping provider switch from a second client instead of cutting off the first switch's running turn", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "paseo-provider-switch-overlap-e2e-"));
    onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));

    const claude = new E2EFakeClient("claude");
    const codex = new E2EFakeClient("codex", true);
    const copilot = new E2EFakeClient("copilot");
    daemon = await createTestPaseoDaemon({
      agentClients: { claude, codex, copilot },
    });

    const url = `ws://127.0.0.1:${daemon.port}/ws`;
    const client1 = await connectClient(url);
    const client2 = await connectClient(url);

    const agent = await client1.client.createAgent({ provider: "claude", cwd });
    await client1.client.sendMessage(agent.id, "Initial Claude prompt", undefined, {
      messageId: "msg-ov-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    let resolveCodexCreate!: () => void;
    codex.createSessionGate = new Promise<void>((resolve) => {
      resolveCodexCreate = resolve;
    });
    let resolveCodexCreateStarted!: () => void;
    const codexCreateStarted = new Promise<void>((resolve) => {
      resolveCodexCreateStarted = resolve;
    });
    codex.onCreateSessionStarted = resolveCodexCreateStarted;

    let resolveCodexTurn!: () => void;
    codex.turnCompletionGate = new Promise<void>((resolve) => {
      resolveCodexTurn = resolve;
    });

    const firstSwitch = client1.client.switchAgentProvider(agent.id, {
      provider: "codex",
      text: "Continue on Codex",
      messageId: "msg-ov-codex",
    });
    await codexCreateStarted;

    // Second client requests a competing switch to Copilot while Client 1's switch is still running.
    const secondSwitch = client2.client.switchAgentProvider(agent.id, {
      provider: "copilot",
      text: "Switch to Copilot instead",
      messageId: "msg-ov-copilot",
    });
    // Give the WebSocket message a tick to queue behind Client 1's switch.
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Release Codex session startup; Codex turn 1 starts and remains running until we release it.
    resolveCodexCreate();

    const [firstOutcome, secondOutcome] = await Promise.allSettled([firstSwitch, secondSwitch]);
    expect(firstOutcome.status).toBe("fulfilled");
    if (firstOutcome.status === "fulfilled") {
      expect(firstOutcome.value.agent?.provider).toBe("codex");
    }
    expect(secondOutcome.status).toBe("rejected");
    if (secondOutcome.status === "rejected") {
      expect(String(secondOutcome.reason)).toMatch(/running/i);
    }

    // Codex session must NOT have been closed mid-turn and Copilot must NOT have opened a session.
    expect(codex.sessions).toHaveLength(1);
    expect(codex.sessions[0].closed).toBe(false);
    expect(copilot.sessions).toHaveLength(0);

    // Let Codex turn 1 complete and verify its reply persisted cleanly.
    resolveCodexTurn();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const timeline = await client1.client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 50,
    });
    expect(timeline.entries.filter((e) => e.item.type === "provider_switch")).toHaveLength(1);
    expect(
      timeline.entries.some(
        (e) => e.item.type === "assistant_message" && e.item.text === "codex reply 1",
      ),
    ).toBe(true);
  });

  it("aborts a provider switch cleanly when a concurrent plain message starts a turn during target session creation", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "paseo-provider-switch-plain-race-e2e-"));
    onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));

    const claude = new E2EFakeClient("claude");
    const codex = new E2EFakeClient("codex", true);
    daemon = await createTestPaseoDaemon({
      agentClients: { claude, codex },
    });

    const url = `ws://127.0.0.1:${daemon.port}/ws`;
    const client1 = await connectClient(url);
    const client2 = await connectClient(url);

    const agent = await client1.client.createAgent({ provider: "claude", cwd });
    await client1.client.sendMessage(agent.id, "First Claude turn", undefined, {
      messageId: "msg-pr-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    let resolveCodexCreate!: () => void;
    codex.createSessionGate = new Promise<void>((resolve) => {
      resolveCodexCreate = resolve;
    });
    let resolveCodexCreateStarted!: () => void;
    const codexCreateStarted = new Promise<void>((resolve) => {
      resolveCodexCreateStarted = resolve;
    });
    codex.onCreateSessionStarted = resolveCodexCreateStarted;

    let resolveClaudeTurn!: () => void;
    claude.turnCompletionGate = new Promise<void>((resolve) => {
      resolveClaudeTurn = resolve;
    });
    let resolveClaudeTurnStarted!: () => void;
    const claudeTurnStarted = new Promise<void>((resolve) => {
      resolveClaudeTurnStarted = resolve;
    });
    claude.onTurnStarted = resolveClaudeTurnStarted;

    const switchPromise = client1.client.switchAgentProvider(agent.id, {
      provider: "codex",
      text: "Switch to Codex",
      messageId: "msg-pr-sw",
    });
    await codexCreateStarted;

    // Start a direct foreground turn on the live Claude session while Codex createSession is awaiting.
    const directStream = daemon.daemon.agentManager.streamAgent(agent.id, "Stay on Claude", {
      clientMessageId: "msg-pr-stay",
    });
    const drainDirectStream = (async () => {
      for await (const _event of directStream) {
        // drain to completion
      }
    })();
    await claudeTurnStarted;

    // Now let Codex session creation finish while Claude's turn is actively running.
    resolveCodexCreate();

    await expect(switchPromise).rejects.toThrow(/running/i);
    expect(claude.sessions[0].closed).toBe(false);
    expect(codex.sessions).toHaveLength(1);
    expect(codex.sessions[0].closed).toBe(true);

    resolveClaudeTurn();
    await drainDirectStream;
    await new Promise((resolve) => setTimeout(resolve, 100));

    const timeline = await client2.client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 50,
    });
    expect(timeline.entries.filter((e) => e.item.type === "provider_switch")).toHaveLength(0);
    expect(
      timeline.entries.some(
        (e) => e.item.type === "assistant_message" && e.item.text === "claude reply 2",
      ),
    ).toBe(true);
  });

  it("excludes turns rewound during target session startup from the switch handoff", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "paseo-provider-switch-rewind-race-e2e-"));
    onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));

    const claude = new E2EFakeClient("claude");
    const codex = new E2EFakeClient("codex", true);
    daemon = await createTestPaseoDaemon({
      agentClients: { claude, codex },
    });

    const url = `ws://127.0.0.1:${daemon.port}/ws`;
    const client1 = await connectClient(url);
    const client2 = await connectClient(url);

    const agent = await client1.client.createAgent({ provider: "claude", cwd });
    await client1.client.sendMessage(agent.id, "Keep this requirement", undefined, {
      messageId: "msg-rw-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await client1.client.sendMessage(agent.id, "Discard this requirement", undefined, {
      messageId: "msg-rw-2",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const beforeRewind = await client1.client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 50,
    });
    const discardRow = beforeRewind.entries.find(
      (e) => e.item.type === "user_message" && e.item.text === "Discard this requirement",
    );
    expect(discardRow?.item.type).toBe("user_message");
    const discardMessageId =
      discardRow?.item.type === "user_message" ? discardRow.item.messageId : undefined;
    expect(discardMessageId).toBeTruthy();

    let resolveCodexCreate!: () => void;
    codex.createSessionGate = new Promise<void>((resolve) => {
      resolveCodexCreate = resolve;
    });
    let resolveCodexCreateStarted!: () => void;
    const codexCreateStarted = new Promise<void>((resolve) => {
      resolveCodexCreateStarted = resolve;
    });
    codex.onCreateSessionStarted = resolveCodexCreateStarted;

    // Client 1 begins switching to Codex; target startup pauses.
    const switchPromise = client1.client.switchAgentProvider(agent.id, {
      provider: "codex",
      text: "Continue on Codex",
      messageId: "msg-rw-sw",
    });
    await codexCreateStarted;

    try {
      // Client 2 rewinds the second Claude turn while Codex is still opening.
      const rewindResp = await client2.client.rewindAgent(
        agent.id,
        discardMessageId!,
        "conversation",
      );
      expect(rewindResp.ok).toBe(true);
    } finally {
      // Always release Codex session startup so daemon teardown never hangs on failure.
      resolveCodexCreate();
    }
    const switched = await switchPromise;
    expect(switched.agent?.provider).toBe("codex");
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Codex's first prompt handoff MUST contain the kept turn and MUST NOT contain the rewound turn.
    expect(codex.sessions).toHaveLength(1);
    const firstCodexPrompt = renderProviderPromptText(codex.sessions[0].receivedPrompts[0]);
    expect(firstCodexPrompt).toContain("Keep this requirement");
    expect(firstCodexPrompt).not.toContain("Discard this requirement");
  });

  it("rejects stale expectedProvider model edits that arrive during a provider switch instead of applying them to the new provider", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "paseo-provider-switch-expected-provider-e2e-"));
    onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));

    const claude = new E2EFakeClient("claude");
    const codex = new E2EFakeClient("codex", true);
    daemon = await createTestPaseoDaemon({
      agentClients: { claude, codex },
    });

    const url = `ws://127.0.0.1:${daemon.port}/ws`;
    const client1 = await connectClient(url);
    const client2 = await connectClient(url);

    const agent = await client1.client.createAgent({ provider: "claude", cwd });
    await client1.client.sendMessage(agent.id, "Start on Claude", undefined, {
      messageId: "msg-ep-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    let resolveCodexAvail!: () => void;
    codex.availabilityGate = new Promise<void>((resolve) => {
      resolveCodexAvail = resolve;
    });
    let resolveCodexAvailStarted!: () => void;
    const codexAvailStarted = new Promise<void>((resolve) => {
      resolveCodexAvailStarted = resolve;
    });
    codex.onAvailabilityCheckStarted = resolveCodexAvailStarted;

    let resolveCodexCreate!: () => void;
    codex.createSessionGate = new Promise<void>((resolve) => {
      resolveCodexCreate = resolve;
    });
    let resolveCodexCreateStarted!: () => void;
    const codexCreateStarted = new Promise<void>((resolve) => {
      resolveCodexCreateStarted = resolve;
    });
    codex.onCreateSessionStarted = resolveCodexCreateStarted;

    const switchPromise = client1.client.switchAgentProvider(agent.id, {
      provider: "codex",
      text: "Switch to Codex",
      messageId: "msg-ep-sw",
    });
    await codexAvailStarted;

    // An older client omitting expectedProvider during the availability check MUST also reject.
    const legacyDuringAvail = client2.client.setAgentModel(agent.id, "claude-opus-avail").then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    resolveCodexAvail();
    await codexCreateStarted;

    // Both a current client sending expectedProvider: "claude" AND an older client omitting
    // expectedProvider MUST reject during the switch instead of applying "claude-opus" to Codex.
    const staleModelEdit = client2.client
      .setAgentModel(agent.id, "claude-opus", { expectedProvider: "claude" })
      .then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
    const legacyModelEdit = client2.client.setAgentModel(agent.id, "claude-opus-legacy").then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    resolveCodexCreate();
    const [switched, availEditOutcome, staleEditOutcome, legacyEditOutcome] = await Promise.all([
      switchPromise,
      legacyDuringAvail,
      staleModelEdit,
      legacyModelEdit,
    ]);
    expect(switched.agent?.provider).toBe("codex");

    // All three stale Claude model edits MUST reject instead of applying to Codex!
    expect(availEditOutcome.status).toBe("rejected");
    if (availEditOutcome.status === "rejected") {
      expect(String(availEditOutcome.error)).toMatch(/switching providers/i);
    }
    expect(staleEditOutcome.status).toBe("rejected");
    if (staleEditOutcome.status === "rejected") {
      expect(String(staleEditOutcome.error)).toMatch(/provider 'claude'.*now using 'codex'/i);
    }
    expect(legacyEditOutcome.status).toBe("rejected");
    if (legacyEditOutcome.status === "rejected") {
      expect(String(legacyEditOutcome.error)).toMatch(/switching providers/i);
    }
    expect(codex.sessions).toHaveLength(1);
    expect(codex.sessions[0].setModelCalls).toEqual([]);

    // Once the switch completes, both expectedProvider: "codex" and legacy edits (omitting expectedProvider) succeed.
    await client1.client.setAgentModel(agent.id, "gpt-5.4", { expectedProvider: "codex" });
    await client2.client.setAgentModel(agent.id, "gpt-5.4-mini");
    expect(codex.sessions[0].setModelCalls).toEqual(["gpt-5.4", "gpt-5.4-mini"]);
  });

  it("keeps waitForFinish following a provider switch started while the target session is still opening", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "paseo-provider-switch-wait-startup-e2e-"));
    onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));

    const claude = new E2EFakeClient("claude");
    const codex = new E2EFakeClient("codex", true);
    daemon = await createTestPaseoDaemon({
      agentClients: { claude, codex },
    });

    const url = `ws://127.0.0.1:${daemon.port}/ws`;
    const client1 = await connectClient(url);
    const client2 = await connectClient(url);

    const agent = await client1.client.createAgent({ provider: "claude", cwd });
    await client1.client.sendMessage(agent.id, "First Claude turn", undefined, {
      messageId: "msg-ws-1",
    });
    const firstFinish = await client2.client.waitForFinish(agent.id, 10_000);
    expect(firstFinish.status).toBe("idle");
    expect(firstFinish.lastMessage).toBe("claude reply 1");

    let resolveCodexCreate!: () => void;
    codex.createSessionGate = new Promise<void>((resolve) => {
      resolveCodexCreate = resolve;
    });
    let resolveCodexCreateStarted!: () => void;
    const codexCreateStarted = new Promise<void>((resolve) => {
      resolveCodexCreateStarted = resolve;
    });
    codex.onCreateSessionStarted = resolveCodexCreateStarted;

    let resolveCodexTurn!: () => void;
    codex.turnCompletionGate = new Promise<void>((resolve) => {
      resolveCodexTurn = resolve;
    });
    let resolveCodexTurnStarted!: () => void;
    const codexTurnStarted = new Promise<void>((resolve) => {
      resolveCodexTurnStarted = resolve;
    });
    codex.onTurnStarted = resolveCodexTurnStarted;

    // Client 1 starts switching to Codex; pause during Codex createSession.
    const switchPromise = client1.client.switchAgentProvider(agent.id, {
      provider: "codex",
      text: "Switch to Codex",
      messageId: "msg-ws-sw",
    });
    await codexCreateStarted;

    // During target startup, the source session is NOT yet blocked from normal turns/rewinds,
    // while Client 2's waitForFinish must wait for the switch instead of returning "claude reply 1".
    expect(daemon.daemon.agentManager.hasInFlightRun(agent.id)).toBe(false);
    let waitSettled = false;
    const waitDuringStartup = client2.client.waitForFinish(agent.id, 15_000).then((res) => {
      waitSettled = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(waitSettled).toBe(false);

    // Let Codex finish opening and start turn 1; waitForFinish must still stay attached.
    resolveCodexCreate();
    await codexTurnStarted;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(waitSettled).toBe(false);

    // Finish Codex's first turn and confirm Client 2 receives Codex's reply, not Claude's.
    resolveCodexTurn();
    const [switched, finish] = await Promise.all([switchPromise, waitDuringStartup]);
    expect(switched.agent?.provider).toBe("codex");
    expect(finish.status).toBe("idle");
    expect(finish.final?.provider).toBe("codex");
    expect(finish.lastMessage).toBe("codex reply 1");
  });
});
