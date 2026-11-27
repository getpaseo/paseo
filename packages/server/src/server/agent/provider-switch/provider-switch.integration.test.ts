import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager, AgentProviderSwitchStartError } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import { ensureAgentLoaded } from "../agent-loading.js";
import { startAgentRun } from "../agent-prompt.js";
import {
  createStoredAgentTimeline,
  TimelineRewindSegmentBoundaryError,
} from "../timeline/index.js";
import { openTestTimelineDatabase } from "../timeline/testing.js";
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
  ConversationRewindResult,
} from "../agent-sdk-types.js";
import { renderProviderPromptText } from "./index.js";

const BASE_CAPABILITIES = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
  supportsRewindConversation: true,
  supportsRewindFiles: true,
  supportsRewindBoth: false,
} as const;

class FakeSession implements AgentSession {
  readonly id: string;
  readonly provider: AgentProvider;
  readonly capabilities = BASE_CAPABILITIES;
  readonly receivedPrompts: Array<{ prompt: AgentPromptInput; options?: AgentRunOptions }> = [];
  readonly fileRewindCalls: string[] = [];
  interruptCalls = 0;
  closed = false;
  private listeners = new Set<(event: AgentStreamEvent) => void>();
  private persistence: AgentPersistenceHandle | null;
  private turnCount = 0;
  private readonly onStartTurn?: (
    session: FakeSession,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ) => Promise<void> | void;
  private readonly onClose?: () => Promise<void> | void;
  private readonly persistAfterFirstTurn: boolean;
  private readonly echoBeforeStartResolves: boolean;

  constructor(params: {
    id: string;
    provider: AgentProvider;
    initialPersistence: AgentPersistenceHandle | null;
    persistAfterFirstTurn?: boolean;
    echoBeforeStartResolves?: boolean;
    onStartTurn?: (
      session: FakeSession,
      prompt: AgentPromptInput,
      options?: AgentRunOptions,
    ) => Promise<void> | void;
    onClose?: () => Promise<void> | void;
  }) {
    this.id = params.id;
    this.provider = params.provider;
    this.persistence = params.initialPersistence;
    this.persistAfterFirstTurn = params.persistAfterFirstTurn ?? false;
    this.echoBeforeStartResolves = params.echoBeforeStartResolves ?? false;
    this.onStartTurn = params.onStartTurn;
    this.onClose = params.onClose;
  }

  emit(event: AgentStreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    this.receivedPrompts.push({ prompt, options });
    if (this.onStartTurn) {
      await this.onStartTurn(this, prompt, options);
    }
    this.turnCount += 1;
    const turnId = `${this.provider}-turn-${this.turnCount}`;
    const providerMessageId = `${this.provider}-msg-${this.turnCount}`;
    if (this.persistAfterFirstTurn && !this.persistence) {
      this.persistence = { provider: this.provider, sessionId: `${this.provider}-late-${this.id}` };
    }
    const rendered = renderProviderPromptText(prompt);
    const emitTurn = () => {
      if (options?.clientMessageId) {
        this.emit({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: {
            type: "user_message",
            text: rendered,
            messageId: providerMessageId,
            clientMessageId: options.clientMessageId,
          },
        });
      }
      this.emit({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: {
          type: "assistant_message",
          text: `${this.provider} reply ${this.turnCount}`,
        },
      });
      this.emit({
        type: "turn_completed",
        provider: this.provider,
        turnId,
      });
    };

    if (this.echoBeforeStartResolves) {
      emitTurn();
    } else {
      queueMicrotask(emitTurn);
    }
    return { turnId };
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    await this.startTurn(prompt, options);
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async *stream(): AsyncGenerator<AgentStreamEvent> {}
  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async revertConversation(): Promise<ConversationRewindResult> {
    return { kind: "after", retainedMessageId: null };
  }

  async revertFiles(input: { messageId: string }): Promise<void> {
    this.fileRewindCalls.push(input.messageId);
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
  }
  async getAvailableModes() {
    return [];
  }
  async getCurrentMode() {
    return null;
  }
  async setMode() {}
  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.persistence?.sessionId ?? null,
      model: `${this.provider}-model`,
    };
  }
  describePersistence(): AgentPersistenceHandle | null {
    return this.persistence;
  }
  async close(): Promise<void> {
    if (this.onClose) {
      await this.onClose();
    }
    this.closed = true;
  }
}

class FakeClient implements AgentClient {
  readonly capabilities = BASE_CAPABILITIES;
  readonly createdSessions: FakeSession[] = [];
  resumeCalls = 0;
  available = true;
  failNextCreate: Error | null = null;
  initialPersistenceNull = false;
  persistAfterFirstTurn = false;
  echoBeforeStartResolves = false;
  onStartTurn?: (
    session: FakeSession,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ) => Promise<void> | void;
  onClose?: () => Promise<void> | void;

  constructor(readonly provider: AgentProvider) {}

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
    if (this.failNextCreate) {
      const error = this.failNextCreate;
      this.failNextCreate = null;
      throw error;
    }
    const id = `${this.provider}-sess-${this.createdSessions.length + 1}`;
    const session = new FakeSession({
      id,
      provider: this.provider,
      initialPersistence: this.initialPersistenceNull
        ? null
        : { provider: this.provider, sessionId: id },
      persistAfterFirstTurn: this.persistAfterFirstTurn,
      echoBeforeStartResolves: this.echoBeforeStartResolves,
      onStartTurn: (activeSession, prompt, options) =>
        this.onStartTurn?.(activeSession, prompt, options),
      onClose: () => this.onClose?.(),
    });
    this.createdSessions.push(session);
    return session;
  }

  async resumeSession(handle: AgentPersistenceHandle): Promise<AgentSession> {
    this.resumeCalls += 1;
    const session = new FakeSession({
      id: handle.sessionId,
      provider: this.provider,
      initialPersistence: handle,
      onStartTurn: this.onStartTurn,
    });
    this.createdSessions.push(session);
    return session;
  }
}

function createHarness() {
  const dir = mkdtempSync(join(tmpdir(), "paseo-switch-test-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = mkdtempSync(join(tmpdir(), "paseo-switch-cwd-"));
  onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
  const logger = createTestLogger();
  const db = openTestTimelineDatabase();
  const timeline = createStoredAgentTimeline(db);
  const storage = new AgentStorage(dir, logger);
  const claude = new FakeClient("claude");
  const codex = new FakeClient("codex");
  const manager = new AgentManager({
    logger,
    registry: storage,
    timeline,
    clients: { claude, codex },
  });
  onTestFinished(async () => {
    await manager.flush().catch(() => undefined);
    await timeline.close().catch(() => undefined);
  });
  return { dir, cwd, logger, db, timeline, storage, claude, codex, manager };
}

async function runAndWaitIdle(
  manager: AgentManager,
  agentId: string,
  prompt: AgentPromptInput,
  clientMessageId: string,
): Promise<void> {
  const logger = createTestLogger();
  const idle = new Promise<void>((resolve) => {
    const unsub = manager.subscribe(
      (event) => {
        if (event.type === "agent_state" && event.agent.lifecycle === "idle") {
          unsub();
          resolve();
        }
      },
      { agentId, replayState: false },
    );
  });
  const dispatch = await startAgentRun(manager, agentId, prompt, logger, {
    runOptions: { clientMessageId },
  });
  if (dispatch.disposition === "turn_started") {
    await dispatch.started;
  }
  await idle;
  await manager.flush();
}

describe("AgentManager provider switching", () => {
  it("switches a live agent to a provider with null initial persistence, preserves history, keeps <chat-history-summary> out of item.text, and tracks previousSessions", async () => {
    const { cwd, manager, storage, timeline, claude, codex } = createHarness();
    // Simulate Codex/Claude returning persistence: null until turn 1 runs
    codex.initialPersistenceNull = true;
    codex.persistAfterFirstTurn = true;

    const agentId = randomUUID();
    const created = await manager.createAgent(
      { provider: "claude", cwd, title: "Auth refactor" },
      agentId,
      { workspaceId: "ws-1", labels: { team: "core" }, metadata: { ticket: "P-1" } },
    );
    await runAndWaitIdle(manager, created.id, "Analyze auth.ts", "msg-c1");

    const switched = await manager.switchAgentProvider(created.id, {
      toProvider: "codex",
      model: "gpt-5.4",
      prompt: "Now rewrite it cleanly",
      messageId: "msg-sw1",
    });

    expect(switched.agent.id).toBe(agentId);
    expect(switched.agent.provider).toBe("codex");
    expect(switched.agent.workspaceId).toBe("ws-1");
    expect(switched.agent.labels).toEqual({ team: "core" });
    expect(switched.agent.metadata).toEqual({ ticket: "P-1" });
    expect(claude.createdSessions[0]!.closed).toBe(true);

    // Marker persisted with toSessionId: null (since codex had null persistence before turn 1)
    const rowsBeforeTurn1 = await timeline.readRows({ agentId });
    const marker = rowsBeforeTurn1.find((r) => r.item.type === "provider_switch");
    expect(marker?.item).toMatchObject({
      type: "provider_switch",
      fromProvider: "claude",
      toProvider: "codex",
      fromSessionId: "claude-sess-1",
      toSessionId: null,
    });

    // Run turn 1 on Codex with the handoffPrompt
    await runAndWaitIdle(manager, agentId, switched.handoffPrompt, "msg-sw1");

    // Codex received the handoff attachment + user prompt
    const codexPrompt1 = codex.createdSessions[0]!.receivedPrompts[0]!.prompt;
    expect(renderProviderPromptText(codexPrompt1)).toContain("<chat-history-summary>");
    expect(renderProviderPromptText(codexPrompt1)).toContain("Analyze auth.ts");

    // Stored timeline rows: earlier rows keep provider "claude", switch prompt keeps clean item.text!
    const allRows = await timeline.readRows({ agentId });
    const claudePrompt = allRows.find(
      (r) => r.item.type === "user_message" && r.item.messageId === "msg-c1",
    );
    const codexPrompt = allRows.find(
      (r) => r.item.type === "user_message" && r.item.messageId === "msg-sw1",
    );
    expect(claudePrompt?.provider).toBe("claude");
    expect(codexPrompt?.provider).toBe("codex");
    expect(codexPrompt?.item).toMatchObject({
      type: "user_message",
      text: "Now rewrite it cleanly",
    });
    expect(codexPrompt?.item.type === "user_message" ? codexPrompt.item.text : "").not.toContain(
      "<chat-history-summary>",
    );
    expect(codexPrompt?.providerPromptText).toContain("<chat-history-summary>");

    // previousSessions tracks Claude's handle: resume lookup ignores it, import lookup finds it
    const stored = await storage.get(agentId);
    expect(stored?.provider).toBe("codex");
    expect(stored?.previousSessions).toEqual([
      expect.objectContaining({ provider: "claude", sessionId: "claude-sess-1" }),
    ]);
    const foundForResume = await storage.listByProviderSession("claude", "claude-sess-1");
    expect(foundForResume).toEqual([]);
    const foundForImport = await storage.listByProviderSession("claude", "claude-sess-1", {
      includePreviousSessions: true,
    });
    expect(foundForImport.map((r) => r.id)).toEqual([agentId]);
  });

  it("keeps the original session live and leaves no switch marker when target creation fails", async () => {
    const { cwd, manager, timeline, claude, codex } = createHarness();
    const created = await manager.createAgent({ provider: "claude", cwd }, randomUUID(), {});
    await runAndWaitIdle(manager, created.id, "Hello", "msg-1");

    codex.failNextCreate = new Error("codex CLI failed to start");
    await expect(
      manager.switchAgentProvider(created.id, {
        toProvider: "codex",
        prompt: "Switch now",
        messageId: "msg-2",
      }),
    ).rejects.toThrow("codex CLI failed to start");

    // Claude session is still live and usable, and no marker or open switch intent exists
    expect(manager.getAgent(created.id)?.provider).toBe("claude");
    expect(claude.createdSessions[0]!.closed).toBe(false);
    expect((await timeline.describe({ agentId: created.id }))?.providerSwitch).toBeNull();
    expect((await timeline.describe({ agentId: created.id }))?.activeSegmentStartSeq).toBe(0);

    await runAndWaitIdle(manager, created.id, "Still on Claude", "msg-3");
    expect(claude.createdSessions[0]!.receivedPrompts).toHaveLength(2);
  });

  it("switches a closed agent directly from SQLite history without booting the old provider", async () => {
    const { cwd, manager, claude, codex } = createHarness();
    const created = await manager.createAgent({ provider: "claude", cwd }, randomUUID(), {});
    await runAndWaitIdle(manager, created.id, "Stored turn", "msg-1");
    await manager.closeAgent(created.id);
    expect(manager.getAgent(created.id)).toBeNull();

    const switched = await manager.switchAgentProvider(created.id, {
      toProvider: "codex",
      prompt: "Continue on Codex",
      messageId: "msg-2",
    });

    expect(switched.agent.provider).toBe("codex");
    expect(claude.resumeCalls).toBe(0);
    expect(renderProviderPromptText(switched.handoffPrompt)).toContain("Stored turn");
    expect(codex.createdSessions).toHaveLength(1);
  });

  it("heals crash recovery for marker_committed with null targetPersistence through ensureAgentLoaded and re-injects context on turn 1", async () => {
    const { cwd, manager, storage, timeline, logger, codex } = createHarness();
    codex.initialPersistenceNull = true;

    const created = await manager.createAgent({ provider: "claude", cwd }, randomUUID(), {});
    await runAndWaitIdle(manager, created.id, "Before crash", "msg-1");
    await manager.closeAgent(created.id);

    // Simulate a crash right after commitProviderSwitch (marker_committed) before StoredAgentRecord updated!
    const intent = await timeline.beginProviderSwitch(
      { agentId: created.id },
      {
        messageId: "msg-crash-sw",
        fromProvider: "claude",
        fromPersistence: { provider: "claude", sessionId: "claude-sess-1" },
        fromModel: "claude-model",
        toProvider: "codex",
        toConfig: { model: "gpt-5.4", modeId: "auto" },
        targetPersistence: null,
        context: { includedItems: 2, truncated: false, charCount: 80, budgetChars: 100_000 },
      },
    );
    await timeline.commitProviderSwitch({ agentId: created.id }, intent.id, {
      markerEntry: {
        provider: "codex",
        item: {
          type: "provider_switch",
          fromProvider: "claude",
          toProvider: "codex",
          fromModel: "claude-model",
          toModel: "gpt-5.4",
          fromSessionId: "claude-sess-1",
          toSessionId: null,
          context: { includedItems: 2, truncated: false, charCount: 80, budgetChars: 100_000 },
        },
      },
      targetPersistence: null,
    });

    // StoredAgentRecord on disk is still stale (points to claude with claude persistence & runtimeInfo)
    const staleRecord = await storage.get(created.id);
    expect(staleRecord?.provider).toBe("claude");

    // ensureAgentLoaded reconciles the committed switch and opens Codex cleanly via createAgentFromRecord
    const loaded = await ensureAgentLoaded(created.id, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    expect(loaded.provider).toBe("codex");
    expect((await timeline.describe({ agentId: created.id }))?.providerSwitch).toBeNull();

    const repairedRecord = await storage.get(created.id);
    expect(repairedRecord?.provider).toBe("codex");
    expect(repairedRecord?.previousSessions).toEqual([
      expect.objectContaining({ provider: "claude", sessionId: "claude-sess-1" }),
    ]);

    // First prompt sent after crash recovery automatically receives fresh pre-switch context!
    await runAndWaitIdle(manager, created.id, "First prompt after recovery", "msg-after-crash");
    const delivered = renderProviderPromptText(
      codex.createdSessions[0]!.receivedPrompts[0]!.prompt,
    );
    expect(delivered).toContain("<chat-history-summary>");
    expect(delivered).toContain("Before crash");
    expect(delivered).toContain("First prompt after recovery");

    // Second prompt in the same segment does NOT double-inject context
    await runAndWaitIdle(manager, created.id, "Second prompt", "msg-after-crash-2");
    const delivered2 = renderProviderPromptText(
      codex.createdSessions[0]!.receivedPrompts[1]!.prompt,
    );
    expect(delivered2).not.toContain("<chat-history-summary>");
  });

  it("re-injects fresh pre-switch context after rewinding turn 1 and after a rejected turn 1, and prevents <chat-history-summary> leak on early echo race", async () => {
    const { cwd, manager, timeline, codex } = createHarness();
    // Simulate early echo race (provider echoes user_message before startTurn resolves!)
    codex.echoBeforeStartResolves = true;

    const created = await manager.createAgent({ provider: "claude", cwd }, randomUUID(), {});
    await runAndWaitIdle(manager, created.id, "Claude context turn", "msg-c1");

    let failFirstCodexTurn = true;
    codex.onStartTurn = () => {
      if (failFirstCodexTurn) {
        failFirstCodexTurn = false;
        throw new Error("Transient Codex start error");
      }
    };

    const switched = await manager.switchAgentProvider(created.id, {
      toProvider: "codex",
      prompt: "Attempt 1",
      messageId: "msg-sw1",
    });

    // Turn 1 rejects before Codex accepts -> rejected user_message recorded
    const logger = createTestLogger();
    await expect(
      (async () => {
        const dispatch = await startAgentRun(manager, created.id, switched.handoffPrompt, logger, {
          runOptions: { clientMessageId: "msg-sw1" },
        });
        if (dispatch.disposition === "turn_started") await dispatch.started;
      })(),
    ).rejects.toThrow("Transient Codex start error");
    await manager.flush();

    // Retry with a fresh messageId (no attachment passed by caller) -> auto-reinjects fresh context!
    await runAndWaitIdle(manager, created.id, "Attempt 2 succeeds", "msg-sw2");
    const retryDelivered = renderProviderPromptText(
      codex.createdSessions[0]!.receivedPrompts[1]!.prompt,
    );
    expect(retryDelivered).toContain("<chat-history-summary>");
    expect(retryDelivered).toContain("Claude context turn");

    // Early echo race MUST NOT leak <chat-history-summary> into item.text!
    const rowsAfterRetry = await timeline.readRows({ agentId: created.id });
    const retryRow = rowsAfterRetry.find(
      (r) => r.item.type === "user_message" && r.item.messageId === "msg-sw2",
    );
    expect(retryRow?.item).toMatchObject({ type: "user_message", text: "Attempt 2 succeeds" });
    expect(retryRow?.item.type === "user_message" ? retryRow.item.text : "").not.toContain(
      "<chat-history-summary>",
    );
    expect(retryRow?.providerPromptText).toContain("<chat-history-summary>");

    // Now rewind Attempt 2 (first accepted post-switch turn) -> pre-switch history & marker stay!
    await manager.rewind(created.id, "msg-sw2", "conversation");
    const rowsAfterRewind = await timeline.readRows({ agentId: created.id });
    expect(rowsAfterRewind.some((r) => r.item.type === "provider_switch")).toBe(true);
    expect(
      rowsAfterRewind.some((r) => r.item.type === "user_message" && r.item.messageId === "msg-c1"),
    ).toBe(true);

    // Sending a fresh prompt after rewinding turn 1 re-injects bounded pre-switch context!
    await runAndWaitIdle(manager, created.id, "After rewind prompt", "msg-sw3");
    const afterRewindDelivered = renderProviderPromptText(
      codex.createdSessions[0]!.receivedPrompts[2]!.prompt,
    );
    expect(afterRewindDelivered).toContain("<chat-history-summary>");
    expect(afterRewindDelivered).toContain("Claude context turn");
    expect(afterRewindDelivered).toContain("After rewind prompt");
  });

  it("keeps waitForAgentEvent following the same chat across provider-switch session replacement while blocking overlapping turns", async () => {
    const { cwd, manager, claude, codex } = createHarness();
    const logger = createTestLogger();

    const created = await manager.createAgent({ provider: "claude", cwd }, randomUUID(), {});
    await runAndWaitIdle(manager, created.id, "Before switch", "msg-before");

    let notifySourceClosing!: () => void;
    const sourceClosing = new Promise<void>((resolve) => {
      notifySourceClosing = resolve;
    });
    let releaseSourceClose!: () => void;
    const sourceCloseGate = new Promise<void>((resolve) => {
      releaseSourceClose = resolve;
    });
    claude.onClose = async () => {
      notifySourceClosing();
      await sourceCloseGate;
    };

    let notifyTargetTurnStarting!: () => void;
    const targetTurnStarting = new Promise<void>((resolve) => {
      notifyTargetTurnStarting = resolve;
    });
    let releaseTargetTurn!: () => void;
    const targetTurnGate = new Promise<void>((resolve) => {
      releaseTargetTurn = resolve;
    });
    codex.onStartTurn = async () => {
      notifyTargetTurnStarting();
      await targetTurnGate;
    };

    const switchPromise = manager.switchAgentProvider(created.id, {
      toProvider: "codex",
      prompt: "After switch",
      messageId: "msg-after",
      admitFirstTurn: async (result, switchReservationToken) => {
        const dispatch = await startAgentRun(manager, created.id, result.handoffPrompt, logger, {
          idleOnly: true,
          skipPluginReload: true,
          switchReservationToken,
          runOptions: { clientMessageId: "msg-after" },
        });
        expect(dispatch.disposition).toBe("turn_started");
      },
    });

    // Wait until the switch holds its reservation and is closing the source session.
    await sourceClosing;

    // Overlap protection remains enforced while the switch reservation is held.
    expect(manager.hasInFlightRun(created.id)).toBe(true);
    expect(() => manager.streamAgent(created.id, "Overlapping prompt")).toThrow(
      /already has an active run/,
    );
    await expect(manager.cancelAgentRun(created.id)).resolves.toEqual({ status: "refused" });

    // Start waitForAgentEvent right before prepareAgentForClosure deletes the source session.
    let waitSettled = false;
    const waitResultPromise = manager.waitForAgentEvent(created.id).then((res) => {
      waitSettled = true;
      return res;
    });

    // Aborting another waiter during the switch reservation still rejects promptly.
    const abortController = new AbortController();
    const abortedWait = manager.waitForAgentEvent(created.id, { signal: abortController.signal });
    abortController.abort();
    await expect(abortedWait).rejects.toThrow(/aborted/i);

    // Let source close finish, register Codex, and atomically hand off into Codex's first turn.
    releaseSourceClose();
    await targetTurnStarting;

    // Waiter MUST NOT have thrown "Agent not found" or resolved early during session replacement.
    await Promise.resolve();
    expect(waitSettled).toBe(false);

    // Complete Codex's turn and confirm the waiter receives Codex's reply on the same chat.
    releaseTargetTurn();
    await switchPromise;
    const waitResult = await waitResultPromise;
    expect(waitResult.status).toBe("idle");
    expect(waitResult.lastMessage).toBe("codex reply 1");
  });

  it("refuses files-only rewind across a provider switch before cancelling a running turn", async () => {
    const { cwd, manager, codex } = createHarness();
    const logger = createTestLogger();

    const created = await manager.createAgent({ provider: "claude", cwd }, randomUUID(), {});
    await runAndWaitIdle(manager, created.id, "Before switch", "msg-c1");

    const switched = await manager.switchAgentProvider(created.id, {
      toProvider: "codex",
      prompt: "First Codex turn",
      messageId: "msg-sw1",
    });
    await runAndWaitIdle(manager, created.id, switched.handoffPrompt, "msg-sw1");

    let notifyRunning!: () => void;
    const runningReady = new Promise<void>((resolve) => {
      notifyRunning = resolve;
    });
    let releaseRunning!: () => void;
    const runningGate = new Promise<void>((resolve) => {
      releaseRunning = resolve;
    });
    codex.onStartTurn = async () => {
      notifyRunning();
      await runningGate;
    };

    const dispatch = await startAgentRun(manager, created.id, "In-flight Codex turn", logger, {
      idleOnly: true,
      skipPluginReload: true,
      runOptions: { clientMessageId: "msg-sw2" },
    });
    expect(dispatch.disposition).toBe("turn_started");
    await runningReady;

    const codexSession = codex.createdSessions[0]!;
    await expect(manager.rewind(created.id, "msg-c1", "files")).rejects.toBeInstanceOf(
      TimelineRewindSegmentBoundaryError,
    );
    await expect(manager.rewind(created.id, "claude-msg-1", "files")).rejects.toBeInstanceOf(
      TimelineRewindSegmentBoundaryError,
    );
    expect(codexSession.fileRewindCalls).toEqual([]);
    expect(codexSession.interruptCalls).toBe(0);

    releaseRunning();
    if (dispatch.disposition === "turn_started") {
      await dispatch.started;
    }
    const done = await manager.waitForAgentEvent(created.id);
    expect(done.status).toBe("idle");
  });
});

// Touch AgentProviderSwitchStartError to verify export
void AgentProviderSwitchStartError;
