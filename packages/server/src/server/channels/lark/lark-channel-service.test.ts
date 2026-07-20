import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../../agent/agent-manager.js";
import type { AgentStorage } from "../../agent/agent-storage.js";
import type { BoundCreateAgentCommand } from "../../agent/create-agent/create.js";
import type { AssistantStore } from "../../assistants/assistant-store.js";
import type { LarkChannelClientAdapter } from "./lark-client-adapter.js";
import { LarkChannelService } from "./lark-channel-service.js";
import { LarkChannelStore } from "./lark-channel-store.js";
import type { NormalizedLarkMessageEvent } from "./lark-message-format.js";

function makeAgent(
  id: string,
  lifecycle: ManagedAgent["lifecycle"],
  lastError?: string,
): ManagedAgent {
  return {
    id,
    lifecycle,
    lastError,
    provider: "claude",
    cwd: "/repo",
    activeForegroundTurnId: null,
    persistence: null,
    config: { provider: "claude", cwd: "/repo" },
  } as ManagedAgent;
}

async function* emptyAgentStream(): AsyncGenerator<never, void, unknown> {
  // Vitest tests only need the run to be accepted; state transitions are
  // driven explicitly through handleAgentManagerEvent below.
}

describe("LarkChannelService", () => {
  let paseoHome: string;

  beforeEach(async () => {
    paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-lark-service-"));
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  function createHarness() {
    const logger = pino({ level: "silent" });
    const store = new LarkChannelStore({ paseoHome, logger });
    const bot = store.configure({
      name: "Support bot",
      appId: "cli_test",
      appSecret: "secret",
      target: {
        kind: "workspace",
        provider: "claude",
        model: null,
        cwd: "/repo",
        workspaceId: null,
      },
    });
    store.setEnabled(bot.id, true);
    const pairing = store.upsertPendingPairing(bot.id, {
      openId: "ou_1",
      unionId: null,
      chatId: "oc_1",
      displayName: "Alice",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:15:00.000Z",
    });
    store.approvePairing(bot.id, pairing.code, "2026-01-01T00:01:00.000Z");

    const lastMessages = new Map<string, string | null>();
    const agents = new Map<string, ManagedAgent>();
    const agentManager = {
      subscribe: vi.fn(() => () => undefined),
      getLastAssistantMessage: vi.fn(async (agentId: string) => lastMessages.get(agentId) ?? null),
      getAgent: vi.fn((agentId: string) => agents.get(agentId) ?? makeAgent(agentId, "idle")),
      tryRunOutOfBand: vi.fn(() => false),
      hasInFlightRun: vi.fn(() => false),
      replaceAgentRun: vi.fn(() => emptyAgentStream()),
      streamAgent: vi.fn(() => emptyAgentStream()),
    } as unknown as AgentManager;
    const agentStorage = {
      get: vi.fn(async () => null),
    } as unknown as AgentStorage;
    const adapter: LarkChannelClientAdapter = {
      testConnection: vi.fn(async () => null),
      startEvents: vi.fn(async () => ({ close: vi.fn() })),
      sendText: vi.fn(async () => undefined),
      replyToMessageInThread: vi.fn(async () => ({
        threadId: "omt_created",
        messageId: "om_ack",
      })),
      replyInThread: vi.fn(async () => undefined),
    };
    const createAgent = vi.fn(async () => {
      const snapshot = makeAgent("agent-created", "idle");
      agents.set(snapshot.id, snapshot);
      return {
        snapshot,
        liveSnapshot: snapshot,
        background: true,
        initialPromptStarted: false,
        initialPromptError: null,
      };
    }) as unknown as BoundCreateAgentCommand;
    const assistantStore = {
      get: vi.fn(() => null),
    } as unknown as AssistantStore;
    const service = new LarkChannelService({
      store,
      adapter,
      agentManager,
      agentStorage,
      createAgent,
      assistantStore,
      logger,
      host: { emitStatusChanged: vi.fn() },
    });
    const emitAgentState = (agentId: string, lifecycle: ManagedAgent["lifecycle"]) =>
      (
        service as unknown as {
          handleAgentManagerEvent(event: AgentManagerEvent): Promise<void>;
        }
      ).handleAgentManagerEvent({
        type: "agent_state",
        agent: makeAgent(agentId, lifecycle),
      });

    return {
      adapter,
      botId: bot.id,
      createAgent,
      emitAgentState,
      lastMessages,
      service,
      store,
    };
  }

  test("uses a thread root message as the reply anchor for existing Lark topics", async () => {
    const harness = createHarness();
    harness.store.recordThreadConversation(harness.botId, {
      chatId: "oc_1",
      threadId: "omt_topic",
      rootMessageId: "om_root",
      userId: "user-1",
      agentId: "agent-1",
      title: "Release plan",
      now: "2026-01-01T00:02:00.000Z",
    });

    await harness.service.handleIncomingEvent(harness.botId, {
      eventId: "evt_1",
      messageId: "om_child",
      chatId: "oc_1",
      threadId: "omt_topic",
      rootMessageId: "om_root",
      openId: "ou_1",
      unionId: null,
      displayName: "Alice",
      topicName: "Release plan",
      text: "Please check this.",
    } satisfies NormalizedLarkMessageEvent);

    harness.lastMessages.set("agent-1", "The answer is ready.");
    await harness.emitAgentState("agent-1", "running");
    await harness.emitAgentState("agent-1", "idle");

    expect(harness.adapter.replyToMessageInThread).not.toHaveBeenCalled();
    expect(harness.adapter.replyInThread).toHaveBeenCalledWith(
      expect.anything(),
      "om_root",
      "The answer is ready.",
    );
    expect(harness.adapter.replyInThread).not.toHaveBeenCalledWith(
      expect.anything(),
      "omt_topic",
      expect.any(String),
    );
  });

  test("uses the ACK message as the reply anchor after creating a new Lark topic", async () => {
    const harness = createHarness();

    await harness.service.handleIncomingEvent(harness.botId, {
      eventId: "evt_2",
      messageId: "om_first",
      chatId: "oc_1",
      threadId: null,
      rootMessageId: null,
      openId: "ou_1",
      unionId: null,
      displayName: "Alice",
      topicName: "New topic",
      text: "Please start a new topic.",
    } satisfies NormalizedLarkMessageEvent);

    expect(harness.adapter.replyToMessageInThread).toHaveBeenCalledWith(
      expect.anything(),
      "om_first",
      expect.any(String),
    );
    expect(
      harness.store.findConversationByThread(harness.botId, "oc_1", "omt_created"),
    ).toMatchObject({
      agentId: "agent-created",
      rootMessageId: "om_first",
    });

    harness.lastMessages.set("agent-created", "Created topic answer.");
    await harness.emitAgentState("agent-created", "running");
    await harness.emitAgentState("agent-created", "idle");

    expect(harness.adapter.replyInThread).toHaveBeenCalledWith(
      expect.anything(),
      "om_ack",
      "Created topic answer.",
    );
    expect(harness.adapter.replyInThread).not.toHaveBeenCalledWith(
      expect.anything(),
      "omt_created",
      expect.any(String),
    );
  });
});
