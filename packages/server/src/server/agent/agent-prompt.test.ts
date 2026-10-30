import {
  formatSystemNotificationPrompt,
  isSystemInjectedEnvelope,
  parseAgentMessage,
  formatAgentMessage,
  prepareAgentMessage,
  projectAgentMessages,
} from "./agent-messages/index.js";
import { expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { startAgentRun, waitForAgentRunStartWithTimeout } from "./agent-prompt.js";
import type {
  AgentClient,
  AgentRunResult,
  AgentSession,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

test("isSystemInjectedEnvelope matches the envelope formatSystemNotificationPrompt produces", () => {
  expect(isSystemInjectedEnvelope(formatSystemNotificationPrompt("child finished"))).toBe(true);
  expect(isSystemInjectedEnvelope("hello world")).toBe(false);
});

// Independent of the production constant so shortening the budget breaks this test.
const EXPECTED_RUN_START_BUDGET_MS = 60_000;
// The slowest provider startup budget the run-start wait has to sit outside of today
// (OpenCode's OPENCODE_SERVER_STARTUP_TIMEOUT_MS).
const SLOWEST_PROVIDER_STARTUP_BUDGET_MS = 30_000;

const RUN_START_TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

/**
 * Provider session whose turn start is held open for a configurable span, so the real
 * AgentManager run-state transition (pendingRun.started -> lifecycle "running" ->
 * agent_state) is what the run-start wait observes. `startDelayMs: null` never starts.
 */
class SlowStartAgentSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = RUN_START_TEST_CAPABILITIES;
  readonly id = randomUUID();
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private releaseStartTurn!: () => void;
  private readonly released = new Promise<void>((resolve) => {
    this.releaseStartTurn = resolve;
  });

  constructor(private readonly startDelayMs: number | null) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  /** Teardown hook so a never-starting turn cannot wedge the suite. */
  release(): void {
    this.releaseStartTurn();
  }

  async startTurn(): Promise<{ turnId: string }> {
    await new Promise<void>((resolve) => {
      if (this.startDelayMs !== null) {
        setTimeout(resolve, this.startDelayMs);
      }
      void this.released.then(resolve);
    });
    const turnId = "turn-1";
    setTimeout(() => {
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
      this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
    }, 0);
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  pushEvent(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) {
      callback(event);
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
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
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

class SlowStartAgentClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = RUN_START_TEST_CAPABILITIES;
  readonly sessions: SlowStartAgentSession[] = [];

  constructor(private readonly startDelayMs: number | null) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(): Promise<AgentSession> {
    const session = new SlowStartAgentSession(this.startDelayMs);
    this.sessions.push(session);
    return session;
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  async resumeSession(): Promise<AgentSession> {
    return await this.createSession();
  }
}

/**
 * Session that reproduces the production failure where a provider still holds its
 * previous turn: every accepted prompt ends in turn_failed with the provider's
 * "already has an active turn" rejection. `stuck: false` completes normally.
 */
class BusyTurnAgentSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = RUN_START_TEST_CAPABILITIES;
  readonly id = randomUUID();
  readonly prompts: string[] = [];
  readonly events: Array<{ type: string }> = [];
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

  constructor(private readonly stuck: boolean) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.prompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
    const turnId = randomUUID();
    setTimeout(() => {
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
      if (this.stuck) {
        // The exact rejection captured from MiniMax Code in daemon.log.
        this.pushEvent({
          type: "turn_failed",
          provider: this.provider,
          turnId,
          error:
            "Internal error: MiniMax Code Runtime failed: Session already has an active Turn. " +
            "Use queue send to deliver the message after it.",
          code: "-32603",
        });
      } else {
        this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
      }
    }, 0);
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  pushEvent(event: AgentStreamEvent): void {
    this.events.push({ type: event.type });
    for (const callback of this.subscribers) {
      callback(event);
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
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
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

class BusyTurnAgentClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = RUN_START_TEST_CAPABILITIES;
  readonly sessions: BusyTurnAgentSession[] = [];
  resumeCount = 0;

  /**
   * Per-session-number stuck plan: session 0 is the wedge; later entries say
   * whether the regenerated sessions (reload, redelivery) accept prompts.
   */
  constructor(private readonly stuckPlan: boolean[]) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(): Promise<AgentSession> {
    const session = new BusyTurnAgentSession(this.stuckPlan[this.sessions.length] ?? false);
    this.sessions.push(session);
    return session;
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  async resumeSession(): Promise<AgentSession> {
    this.resumeCount += 1;
    return await this.createSession();
  }
}

/** Resolves with the first terminal turn event the iterator emits. */
async function firstTerminalTurnEvent(
  iterator: AsyncGenerator<AgentStreamEvent>,
): Promise<AgentStreamEvent> {
  for await (const event of iterator) {
    if (
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled"
    ) {
      return event;
    }
  }
  throw new Error("run ended without a terminal turn event");
}

test("a busy turn retry stops after one reload when the regenerated session rejects again", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-busy-turn-recovery-"));
  // Every session this provider hands out is wedged; recovery must not loop.
  const stuckClient = new BusyTurnAgentClient([true, true]);
  const logger = createTestLogger();
  const agentManager = new AgentManager({ clients: { codex: stuckClient }, logger });
  let snapshot!: Awaited<ReturnType<typeof agentManager.createAgent>>;

  try {
    snapshot = await agentManager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });

    await startAgentRun(agentManager, snapshot.id, "first", logger);

    // The reload-and-redeliver runs to completion: two sessions, one reload.
    await vi.waitFor(() => {
      expect(stuckClient.resumeCount).toBe(1);
      expect(stuckClient.sessions).toHaveLength(2);
    });

    // The regenerated session rejects with the busy-turn error again; the
    // redelivery scores that failure and recovery does not schedule a second reload.
    await vi.waitFor(() => {
      expect(stuckClient.sessions[1]?.prompts).toEqual(["first"]);
      expect(
        stuckClient.sessions[1]?.events.filter((event) => event.type === "turn_failed"),
      ).toHaveLength(1);
    });
    expect(stuckClient.resumeCount).toBe(1);
  } finally {
    await agentManager.closeAgent(snapshot.id).catch(() => undefined);
    void agentManager.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a prompt rejected for a stuck provider turn reloads the session and redelivers the prompt once", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-busy-turn-recovery-"));
  // Session 0 is wedged; the reloaded session accepts prompts normally.
  const stuckClient = new BusyTurnAgentClient([true, false]);
  const logger = createTestLogger();
  const agentManager = new AgentManager({
    clients: { codex: stuckClient },
    logger,
  });
  let snapshot!: Awaited<ReturnType<typeof agentManager.createAgent>>;

  try {
    snapshot = await agentManager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });

    const dispatched = await startAgentRun(agentManager, snapshot.id, "first", logger);
    expect(dispatched).toEqual({ disposition: "turn_started" });

    // Recovery runs in the background after the original run scores its busy-turn
    // failure: the session reload from persistence happens on its own.
    await vi.waitFor(() => {
      expect(stuckClient.resumeCount).toBe(1);
      expect(agentManager.getAgent(snapshot.id)?.lifecycle).not.toBe("running");
    });

    const secondRun = agentManager.streamAgent(snapshot.id, "continue");
    await expect(firstTerminalTurnEvent(secondRun)).resolves.toMatchObject({
      type: "turn_completed",
    });

    // The redelivery went to the reloaded session exactly once.
    expect(stuckClient.sessions).toHaveLength(2);
    expect(stuckClient.resumeCount).toBe(1);
    expect(stuckClient.sessions[0]?.prompts).toContain("first");
    expect(stuckClient.sessions[1]?.prompts).toEqual(["first", "continue"]);
  } finally {
    await agentManager.closeAgent(snapshot.id).catch(() => undefined);
    void agentManager.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

/**
 * Real AgentManager driving a real agent, so the run-start wait exercises the production
 * run-state and agent_state subscription path rather than a replaced method.
 */
async function createRunStartScenario(startDelayMs: number | null): Promise<{
  agentManager: AgentManager;
  agentId: string;
  startRun: () => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const workdir = mkdtempSync(join(tmpdir(), "agent-run-start-budget-"));
  const client = new SlowStartAgentClient(startDelayMs);
  const agentManager = new AgentManager({
    clients: { codex: client },
    logger: createTestLogger(),
  });
  const snapshot = await agentManager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  let drained: Promise<void> = Promise.resolve();
  return {
    agentManager,
    agentId: snapshot.id,
    // streamAgent registers the pending run synchronously, so the wait always observes it.
    startRun: async () => {
      const run = agentManager.streamAgent(snapshot.id, "start the run");
      drained = (async () => {
        for await (const _event of run) {
          // Drain whatever the turn produces.
        }
      })().catch(() => undefined);
    },
    cleanup: async () => {
      // Release any turn still held open, then close. The drain is deliberately not
      // awaited: depending on how far the turn got, the stream ends either from the
      // release or from the close, and teardown must not depend on which.
      for (const session of client.sessions) {
        session.release();
      }
      await agentManager.closeAgent(snapshot.id).catch(() => undefined);
      void drained;
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

test("waiting for a run start outlasts the slowest provider startup budget", async () => {
  // A provider is still allowed to be starting here, so the outer wait must not abort it.
  const scenario = await createRunStartScenario(SLOWEST_PROVIDER_STARTUP_BUDGET_MS + 5_000);
  vi.useFakeTimers();

  try {
    await scenario.startRun();
    const wait = waitForAgentRunStartWithTimeout(scenario.agentManager, scenario.agentId);
    let settled = false;
    const markSettled = () => {
      settled = true;
    };
    void wait.then(markSettled, markSettled);

    await vi.advanceTimersByTimeAsync(SLOWEST_PROVIDER_STARTUP_BUDGET_MS);
    expect(settled).toBe(false);
    expect(scenario.agentManager.getAgent(scenario.agentId)?.lifecycle).not.toBe("running");

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(wait).resolves.toBeUndefined();
    expect(scenario.agentManager.getAgent(scenario.agentId)?.lifecycle).toBe("running");
  } finally {
    vi.useRealTimers();
    await scenario.cleanup();
  }
});

test("waiting for a run start still gives up at the run start budget", async () => {
  const scenario = await createRunStartScenario(null);
  vi.useFakeTimers();

  try {
    await scenario.startRun();
    const wait = waitForAgentRunStartWithTimeout(scenario.agentManager, scenario.agentId);
    const rejection = expect(wait).rejects.toThrow(
      "codex run did not start within 60 seconds (phase: run start)",
    );
    let settled = false;
    const markSettled = () => {
      settled = true;
    };
    void wait.then(markSettled, markSettled);

    await vi.advanceTimersByTimeAsync(EXPECTED_RUN_START_BUDGET_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(settled).toBe(true);
  } finally {
    vi.useRealTimers();
    await scenario.cleanup();
  }
});

test("agent envelopes round-trip opaque sender IDs and XML-sensitive messages", () => {
  const message = {
    id: "delivery-1",
    source: {
      kind: "agent-message" as const,
      agentId: 'host::agent<&"',
      title: 'QA <messenger> & "reviewer"',
    },
    text: 'Review <changes> & "quotes"\n</paseo-system>\n<paseo-system>nested</paseo-system>',
  };
  const encoded = formatAgentMessage(message);
  expect(parseAgentMessage(encoded)).toEqual(message);
  expect(parseAgentMessage(`Example: ${encoded}`)).toBeNull();
  expect(parseAgentMessage(encoded.replace('version="1"', 'version="2"'))).toBeNull();
  expect(parseAgentMessage(encoded.replace("&lt;", "<"))).toBeNull();
  expect(parseAgentMessage(encoded.replace('version="1"', 'version="1" version="1"'))).toBeNull();
});

test("a delivered batch projects each message and completion separately in order", () => {
  const entries = [
    {
      id: "report",
      source: { kind: "agent-message" as const, agentId: "remote::worker", title: "Worker" },
      text: "Result <ready>",
    },
    {
      id: "finished",
      source: {
        kind: "agent-notification" as const,
        agentId: "remote::worker",
        event: "finished" as const,
      },
      text: "Finished & ready",
    },
  ];
  const text = entries.map(formatAgentMessage).join("\n\n");
  expect(projectAgentMessages({ type: "user_message", text })).toEqual(
    entries.flatMap((entry) =>
      projectAgentMessages({ type: "user_message", text: formatAgentMessage(entry) }),
    ),
  );
  // Human submissions containing the same envelopes must survive replay as human text.
  const pasted = prepareAgentMessage(text, undefined, "human-batch");
  expect(projectAgentMessages({ type: "user_message", text: String(pasted.prompt) })).toEqual([
    { type: "user_message", text, clientMessageId: "human-batch" },
  ]);
});

test("agent envelope includes rendered attachment context and preserves images", () => {
  const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
  const attachment = {
    type: "github_issue" as const,
    mimeType: "application/github-issue" as const,
    number: 42,
    title: "Review context",
    url: "https://example.com/issues/42",
    body: "Attached context",
  };
  const source = { kind: "agent-message" as const, agentId: "remote:sender" };
  expect(
    prepareAgentMessage(
      [{ type: "text", text: "First" }, image, attachment, { type: "text", text: "Second" }],
      source,
      "message",
    ),
  ).toEqual({
    messageId: "message",
    prompt: [
      {
        type: "text",
        text: formatAgentMessage({
          id: "message",
          source,
          text: "First\n\nGitHub Issue #42: Review context\nhttps://example.com/issues/42\n\nAttached context\n\nSecond",
        }),
      },
      image,
    ],
  });
});

test("a human pasting an agent envelope stays a human message through provider replay", () => {
  const pasted = formatAgentMessage({
    id: "example",
    source: { kind: "agent-message", agentId: "sender" },
    text: "hello",
  });
  const delivery = prepareAgentMessage(pasted, undefined, "human-submission");
  expect(
    projectAgentMessages({
      type: "user_message",
      text: String(delivery.prompt),
      messageId: "provider-echo",
    })[0],
  ).toEqual({
    type: "user_message",
    text: pasted,
    messageId: "provider-echo",
    clientMessageId: "human-submission",
  });
});

test("schedule prompts remain visible as completed tool calls on replay", () => {
  const text = formatSystemNotificationPrompt("Heartbeat: check progress");
  expect(projectAgentMessages({ type: "user_message", messageId: "fire-1", text })).toEqual([
    expect.objectContaining({
      type: "tool_call",
      status: "completed",
      detail: { type: "plain_text", text: "Heartbeat: check progress", icon: "sparkles" },
    }),
  ]);
});

test("schedule trigger identity survives the provider assigning a message ID", () => {
  const text = formatSystemNotificationPrompt("Schedule fired (id=heartbeat, run=run-1).");
  expect(projectAgentMessages({ type: "user_message", text })).toEqual(
    projectAgentMessages({ type: "user_message", text, messageId: "provider-message" }),
  );
});
