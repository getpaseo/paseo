import type pino from "pino";
import type { LarkChannelStatus, SessionInboundMessage } from "@getpaseo/protocol/messages";
import type { AgentManager, AgentManagerEvent } from "../../agent/agent-manager.js";
import type { AgentStorage } from "../../agent/agent-storage.js";
import { sendPromptToAgent } from "../../agent/agent-prompt.js";
import type { BoundCreateAgentCommand } from "../../agent/create-agent/create.js";
import type { AssistantStore } from "../../assistants/assistant-store.js";
import { buildAssistantInitialPrompt } from "../../assistants/assistant-prompt.js";
import {
  type LarkChannelClientAdapter,
  type LarkChannelEventSubscription,
} from "./lark-client-adapter.js";
import {
  LarkChannelStore,
  type ConfigureLarkChannelStoreInput,
  type LarkChannelRuntimeStatusInput,
  type StoredLarkChannelBot,
  type StoredLarkChannelConfig,
} from "./lark-channel-store.js";
import {
  formatLarkUserPrompt,
  getLarkEventDedupeKey,
  splitLarkText,
  type NormalizedLarkMessageEvent,
} from "./lark-message-format.js";

const PAIRING_TTL_MS = 15 * 60 * 1000;
const EVENT_DEDUPE_TTL_MS = 5 * 60 * 1000;
const THREAD_ACK_TEXT = "Received. Paseo is working on this topic…";

function formatLarkProcessingError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return String(error);
}

export type LarkChannelRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "channel.lark.get_status.request"
      | "channel.lark.configure.request"
      | "channel.lark.delete_bot.request"
      | "channel.lark.test_connection.request"
      | "channel.lark.set_enabled.request"
      | "channel.lark.approve_pairing.request"
      | "channel.lark.reject_pairing.request"
      | "channel.lark.revoke_user.request";
  }
>;

export interface LarkChannelServiceHost {
  emitStatusChanged: (status: LarkChannelStatus) => void;
}

interface PendingRelay {
  botId: string;
  agentId: string;
  chatId: string;
  threadId: string;
  replyMessageId: string;
  lastAssistantMessage: string | null;
  hasSeenRunning: boolean;
}

interface ResolvedLarkThread {
  threadId: string;
  replyMessageId: string;
}

interface ResolvedLarkTarget {
  provider: string;
  model: string | null;
  cwd: string;
  workspaceId: string | null;
  initialPrompt: string;
  assistantId: string | null;
}

export class LarkChannelService {
  private readonly store: LarkChannelStore;
  private readonly adapter: LarkChannelClientAdapter;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly createAgent: BoundCreateAgentCommand;
  private readonly assistantStore: AssistantStore;
  private readonly logger: pino.Logger;
  private readonly host: LarkChannelServiceHost;
  private readonly subscriptions = new Map<string, LarkChannelEventSubscription>();
  private readonly runtimes = new Map<string, LarkChannelRuntimeStatusInput>();
  private readonly eventDedupe = new Map<string, number>();
  private readonly pendingRelays = new Map<string, PendingRelay>();
  private readonly unsubscribeAgentEvents: () => void;

  constructor(options: {
    store: LarkChannelStore;
    adapter: LarkChannelClientAdapter;
    agentManager: AgentManager;
    agentStorage: AgentStorage;
    createAgent: BoundCreateAgentCommand;
    assistantStore: AssistantStore;
    logger: pino.Logger;
    host: LarkChannelServiceHost;
  }) {
    this.store = options.store;
    this.adapter = options.adapter;
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.createAgent = options.createAgent;
    this.assistantStore = options.assistantStore;
    this.logger = options.logger.child({ module: "lark-channel-service" });
    this.host = options.host;
    this.unsubscribeAgentEvents = this.agentManager.subscribe((event) => {
      void this.handleAgentManagerEvent(event);
    });
    this.syncRuntimeBots();
  }

  getStatus(): LarkChannelStatus {
    this.store.cleanupExpiredPairings(new Date().toISOString());
    this.syncRuntimeBots();
    return this.store.getStatus({ byBotId: this.runtimes });
  }

  async start(): Promise<void> {
    const bots = this.store.getBots();
    if (bots.length === 0) {
      this.emitStatusChanged();
      return;
    }
    for (const bot of bots) {
      await this.startBot(bot);
    }
  }

  async stop(): Promise<void> {
    for (const subscription of this.subscriptions.values()) {
      subscription.close();
    }
    this.subscriptions.clear();
    for (const bot of this.store.getBots()) {
      this.setRuntime(bot.id, {
        connectionStatus: "disabled",
        error: null,
        bot: null,
      });
    }
    this.unsubscribeAgentEvents();
    this.emitStatusChanged();
  }

  async configure(
    input: ConfigureLarkChannelStoreInput,
  ): Promise<ReturnType<LarkChannelService["getStatus"]>> {
    const storedBot = this.store.configure(input);
    await this.startBot(storedBot);
    this.emitStatusChanged();
    return this.getStatus();
  }

  async deleteBot(botId: string): Promise<ReturnType<LarkChannelService["getStatus"]>> {
    this.closeSubscription(botId);
    this.runtimes.delete(botId);
    if (!this.store.deleteBot(botId)) {
      throw new Error("Lark bot not found");
    }
    this.emitStatusChanged();
    return this.getStatus();
  }

  async testConnection(botId?: string): Promise<ReturnType<LarkChannelService["getStatus"]>> {
    const storedBot = this.requireStoredBot(botId);
    const runtime = this.ensureRuntime(storedBot.id, storedBot.config);
    runtime.bot = await this.adapter.testConnection(storedBot.config);
    runtime.error = null;
    if (runtime.connectionStatus === "error") {
      runtime.connectionStatus = storedBot.config.enabled ? "connected" : "idle";
    }
    this.emitStatusChanged();
    return this.getStatus();
  }

  async setEnabled(
    enabled: boolean,
    botId?: string,
  ): Promise<ReturnType<LarkChannelService["getStatus"]>> {
    const storedBot = this.store.setEnabled(botId, enabled);
    if (!enabled) {
      this.closeSubscription(storedBot.id);
      this.setRuntime(storedBot.id, {
        connectionStatus: "disabled",
        error: null,
        bot: this.ensureRuntime(storedBot.id, storedBot.config).bot,
      });
      this.emitStatusChanged();
      return this.getStatus();
    }
    if (!this.hasCredentials(storedBot.config)) {
      const disabledBot = this.store.setEnabled(storedBot.id, false);
      this.closeSubscription(storedBot.id);
      this.setRuntime(storedBot.id, {
        connectionStatus: "error",
        error: "Lark App ID and App Secret are required",
        bot: this.ensureRuntime(disabledBot.id, disabledBot.config).bot,
      });
      this.emitStatusChanged();
      return this.getStatus();
    }
    await this.restartSubscription(storedBot.id, storedBot.config);
    return this.getStatus();
  }

  approvePairing(code: string, botId?: string): ReturnType<LarkChannelService["getStatus"]> {
    const user = this.store.approvePairing(botId, code, new Date().toISOString());
    if (!user) {
      throw new Error("Pairing request not found");
    }
    this.emitStatusChanged();
    return this.getStatus();
  }

  rejectPairing(code: string, botId?: string): ReturnType<LarkChannelService["getStatus"]> {
    if (!this.store.rejectPairing(botId, code)) {
      throw new Error("Pairing request not found");
    }
    this.emitStatusChanged();
    return this.getStatus();
  }

  revokeUser(userId: string, botId?: string): ReturnType<LarkChannelService["getStatus"]> {
    if (!this.store.revokeUser(botId, userId)) {
      throw new Error("Authorized user not found");
    }
    this.emitStatusChanged();
    return this.getStatus();
  }

  async handleIncomingEvent(botId: string, event: NormalizedLarkMessageEvent): Promise<void> {
    const now = Date.now();
    this.evictDedupe(now);
    const dedupeKey = `${botId}:${getLarkEventDedupeKey(event)}`;
    if (this.eventDedupe.has(dedupeKey)) {
      return;
    }
    this.eventDedupe.set(dedupeKey, now + EVENT_DEDUPE_TTL_MS);

    const storedBot = this.store.getBot(botId);
    if (!storedBot) {
      return;
    }
    const config = storedBot.config;
    if (!config.enabled) {
      return;
    }
    const user = this.store.findAuthorizedUser(botId, {
      openId: event.openId,
      unionId: event.unionId,
      chatId: event.chatId,
    });
    if (!user) {
      const createdAt = new Date(now).toISOString();
      const expiresAt = new Date(now + PAIRING_TTL_MS).toISOString();
      const pairing = this.store.upsertPendingPairing(botId, {
        openId: event.openId,
        unionId: event.unionId,
        chatId: event.chatId,
        displayName: event.displayName,
        createdAt,
        expiresAt,
      });
      this.emitStatusChanged();
      await this.sendTextSafe(
        botId,
        config,
        event.chatId,
        `Pairing requested. Open Paseo Settings > Channels and approve code ${pairing.code}.`,
      );
      return;
    }

    const thread = await this.resolveThread(botId, config, event);
    if (!thread) {
      return;
    }
    const { threadId, replyMessageId } = thread;
    if (!this.isTargetConfigured(config)) {
      await this.sendThreadTextSafe(
        botId,
        config,
        replyMessageId,
        "Lark is connected, but provider and workspace are not configured. Open Paseo Settings > Channels to choose a provider, model, and workspace.",
      );
      return;
    }

    const nowIso = new Date(now).toISOString();
    const existing = this.store.findConversationByThread(botId, event.chatId, threadId);
    try {
      if (existing) {
        await this.relayToExistingAgent({
          botId,
          config,
          event,
          userId: user.id,
          threadId,
          replyMessageId,
          agentId: existing.agentId,
          nowIso,
        });
        return;
      }

      await this.createTopicAgent({
        botId,
        config,
        event,
        userId: user.id,
        threadId,
        replyMessageId,
        nowIso,
      });
    } catch (error) {
      const message = formatLarkProcessingError(error);
      this.logger.error({ err: error, botId, threadId }, "Failed to process Lark message");
      this.setRuntime(botId, {
        connectionStatus: "error",
        error: message,
        bot: this.ensureRuntime(botId, config).bot,
      });
      this.emitStatusChanged();
      await this.sendThreadTextSafe(
        botId,
        config,
        replyMessageId,
        `Paseo failed to process this message: ${message}`,
      );
    }
  }

  private async restartSubscription(botId: string, config: StoredLarkChannelConfig): Promise<void> {
    this.closeSubscription(botId);
    const previousBotInfo = this.ensureRuntime(botId, config).bot;
    this.setRuntime(botId, {
      connectionStatus: "connecting",
      error: null,
      bot: previousBotInfo,
    });
    this.emitStatusChanged();
    try {
      const botInfo = await this.adapter.testConnection(config);
      const subscription = await this.adapter.startEvents(config, (event) =>
        this.handleIncomingEvent(botId, event),
      );
      this.subscriptions.set(botId, subscription);
      this.setRuntime(botId, {
        connectionStatus: "connected",
        error: null,
        bot: botInfo,
      });
    } catch (error) {
      this.setRuntime(botId, {
        connectionStatus: "error",
        error: error instanceof Error ? error.message : String(error),
        bot: previousBotInfo,
      });
      this.logger.error({ err: error, botId }, "Failed to start Lark channel");
    }
    this.emitStatusChanged();
  }

  private async relayToExistingAgent(input: {
    botId: string;
    config: StoredLarkChannelConfig;
    event: NormalizedLarkMessageEvent;
    userId: string;
    threadId: string;
    replyMessageId: string;
    agentId: string;
    nowIso: string;
  }): Promise<void> {
    const lastAssistantMessage = await this.agentManager.getLastAssistantMessage(input.agentId);
    this.pendingRelays.set(input.agentId, {
      botId: input.botId,
      agentId: input.agentId,
      chatId: input.event.chatId,
      threadId: input.threadId,
      replyMessageId: input.replyMessageId,
      lastAssistantMessage,
      hasSeenRunning: false,
    });
    this.store.recordThreadConversation(input.botId, {
      agentId: input.agentId,
      chatId: input.event.chatId,
      threadId: input.threadId,
      rootMessageId: input.event.rootMessageId ?? input.event.messageId,
      userId: input.userId,
      title: input.event.topicName,
      now: input.nowIso,
    });
    await sendPromptToAgent({
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      agentId: input.agentId,
      prompt: formatLarkUserPrompt(input.event),
      unarchive: true,
      logger: this.logger,
    });
  }

  private async createTopicAgent(input: {
    botId: string;
    config: StoredLarkChannelConfig;
    event: NormalizedLarkMessageEvent;
    userId: string;
    threadId: string;
    replyMessageId: string;
    nowIso: string;
  }): Promise<void> {
    const target = this.resolveTarget(input.config, input.event);
    if (!target) {
      await this.sendThreadTextSafe(
        input.botId,
        input.config,
        input.replyMessageId,
        "Lark is connected, but the selected assistant or workspace target is not available. Open Paseo Settings > Channels to update the bot binding.",
      );
      return;
    }
    const title = input.event.topicName;
    const { snapshot } = await this.createAgent({
      kind: "mcp",
      provider: target.provider,
      title,
      workspaceTitle: title,
      config: {
        title,
        ...(target.model ? { model: target.model } : {}),
      },
      cwd: target.cwd,
      workspaceId: target.workspaceId ?? undefined,
      labels: {
        channel: "lark",
        "lark.botId": input.botId,
        "lark.chatId": input.event.chatId,
        "lark.threadId": input.threadId,
        "lark.userId": input.userId,
        ...(target.assistantId ? { assistantId: target.assistantId } : {}),
      },
      background: true,
      notifyOnFinish: false,
      promptFailure: "throw",
    });
    this.store.recordThreadConversation(input.botId, {
      agentId: snapshot.id,
      chatId: input.event.chatId,
      threadId: input.threadId,
      rootMessageId: input.event.rootMessageId ?? input.event.messageId,
      userId: input.userId,
      title,
      now: input.nowIso,
    });
    this.pendingRelays.set(snapshot.id, {
      botId: input.botId,
      agentId: snapshot.id,
      chatId: input.event.chatId,
      threadId: input.threadId,
      replyMessageId: input.replyMessageId,
      lastAssistantMessage: null,
      hasSeenRunning: false,
    });
    await sendPromptToAgent({
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      agentId: snapshot.id,
      prompt: target.initialPrompt,
      unarchive: true,
      logger: this.logger,
    });
  }

  private resolveTarget(
    config: StoredLarkChannelConfig,
    event: NormalizedLarkMessageEvent,
  ): ResolvedLarkTarget | null {
    const target = config.target;
    if (target.kind === "workspace") {
      if (!target.provider || !target.cwd) {
        return null;
      }
      return {
        provider: target.provider,
        model: target.model ?? null,
        cwd: target.cwd,
        workspaceId: target.workspaceId,
        initialPrompt: formatLarkUserPrompt(event),
        assistantId: null,
      };
    }
    if (!target.assistantId || !target.cwd) {
      return null;
    }
    const assistant = this.assistantStore.get(target.assistantId);
    if (!assistant) {
      return null;
    }
    return {
      provider: target.provider ?? "claude",
      model: target.model ?? null,
      cwd: target.cwd,
      workspaceId: target.workspaceId,
      initialPrompt: buildAssistantInitialPrompt(assistant, formatLarkUserPrompt(event)),
      assistantId: assistant.id,
    };
  }

  private async resolveThread(
    botId: string,
    config: StoredLarkChannelConfig,
    event: NormalizedLarkMessageEvent,
  ): Promise<ResolvedLarkThread | null> {
    if (event.threadId) {
      return {
        threadId: event.threadId,
        replyMessageId: this.resolveReplyMessageId(event),
      };
    }
    try {
      const reply = await this.adapter.replyToMessageInThread(
        config,
        event.messageId,
        THREAD_ACK_TEXT,
      );
      if (reply.threadId) {
        return {
          threadId: reply.threadId,
          replyMessageId: reply.messageId ?? event.messageId,
        };
      }
      this.logger.warn({ messageId: event.messageId }, "Lark reply did not return thread_id");
      return null;
    } catch (error) {
      this.logger.error({ err: error, messageId: event.messageId }, "Failed to create Lark thread");
      this.setRuntime(botId, {
        connectionStatus: "error",
        error: error instanceof Error ? error.message : String(error),
        bot: this.ensureRuntime(botId, config).bot,
      });
      this.emitStatusChanged();
      return null;
    }
  }

  private resolveReplyMessageId(event: NormalizedLarkMessageEvent): string {
    return event.rootMessageId ?? event.messageId;
  }

  private async handleAgentManagerEvent(event: AgentManagerEvent): Promise<void> {
    if (event.type !== "agent_state") {
      return;
    }
    const relay = this.pendingRelays.get(event.agent.id);
    if (!relay) {
      return;
    }
    if (event.agent.lifecycle === "running") {
      relay.hasSeenRunning = true;
      return;
    }
    if (event.agent.lifecycle === "error") {
      this.pendingRelays.delete(event.agent.id);
      const storedBot = this.store.getBot(relay.botId);
      if (!storedBot) {
        return;
      }
      await this.sendThreadTextSafe(
        relay.botId,
        storedBot.config,
        relay.replyMessageId,
        event.agent.lastError ?? "Paseo agent failed.",
      );
      return;
    }
    if (event.agent.lifecycle !== "idle" || !relay.hasSeenRunning) {
      return;
    }
    this.pendingRelays.delete(event.agent.id);
    const message = await this.agentManager.getLastAssistantMessage(event.agent.id);
    const text = message && message !== relay.lastAssistantMessage ? message : "Agent finished.";
    const storedBot = this.store.getBot(relay.botId);
    if (!storedBot) {
      return;
    }
    await this.sendThreadTextSafe(relay.botId, storedBot.config, relay.replyMessageId, text);
    this.store.markConversationOutbound(
      relay.botId,
      event.agent.id,
      relay.chatId,
      relay.threadId,
      new Date().toISOString(),
    );
  }

  private async sendTextSafe(
    botId: string,
    config: StoredLarkChannelConfig,
    chatId: string,
    text: string,
  ): Promise<void> {
    for (const chunk of splitLarkText(text)) {
      try {
        await this.adapter.sendText(config, chatId, chunk);
      } catch (error) {
        this.logger.error({ err: error, chatId }, "Failed to send Lark message");
        this.setRuntime(botId, {
          connectionStatus: "error",
          error: error instanceof Error ? error.message : String(error),
          bot: this.ensureRuntime(botId, config).bot,
        });
        this.emitStatusChanged();
        return;
      }
    }
  }

  private async sendThreadTextSafe(
    botId: string,
    config: StoredLarkChannelConfig,
    replyMessageId: string,
    text: string,
  ): Promise<void> {
    for (const chunk of splitLarkText(text)) {
      try {
        await this.adapter.replyInThread(config, replyMessageId, chunk);
      } catch (error) {
        this.logger.error(
          { err: error, messageId: replyMessageId },
          "Failed to send Lark thread message",
        );
        this.setRuntime(botId, {
          connectionStatus: "error",
          error: error instanceof Error ? error.message : String(error),
          bot: this.ensureRuntime(botId, config).bot,
        });
        this.emitStatusChanged();
        return;
      }
    }
  }

  private hasCredentials(config: StoredLarkChannelConfig): boolean {
    return Boolean(config.appId && config.appSecret);
  }

  private async startBot(bot: StoredLarkChannelBot): Promise<void> {
    if (!bot.config.enabled) {
      this.closeSubscription(bot.id);
      this.setRuntime(bot.id, {
        connectionStatus: "disabled",
        error: null,
        bot: this.ensureRuntime(bot.id, bot.config).bot,
      });
      this.emitStatusChanged();
      return;
    }
    if (!this.hasCredentials(bot.config)) {
      this.closeSubscription(bot.id);
      this.setRuntime(bot.id, {
        connectionStatus: "error",
        error: "Lark App ID and App Secret are required",
        bot: this.ensureRuntime(bot.id, bot.config).bot,
      });
      this.emitStatusChanged();
      return;
    }
    await this.restartSubscription(bot.id, bot.config);
  }

  private syncRuntimeBots(): void {
    const bots = this.store.getBots();
    const botIds = new Set(bots.map((bot) => bot.id));
    for (const bot of bots) {
      this.ensureRuntime(bot.id, bot.config);
    }
    for (const botId of Array.from(this.runtimes.keys())) {
      if (!botIds.has(botId)) {
        this.runtimes.delete(botId);
      }
    }
  }

  private ensureRuntime(
    botId: string,
    config: StoredLarkChannelConfig,
  ): LarkChannelRuntimeStatusInput {
    const existing = this.runtimes.get(botId);
    if (existing) {
      return existing;
    }
    const runtime: LarkChannelRuntimeStatusInput = {
      connectionStatus: config.enabled ? "idle" : "disabled",
      error: null,
      bot: null,
    };
    this.runtimes.set(botId, runtime);
    return runtime;
  }

  private setRuntime(botId: string, runtime: LarkChannelRuntimeStatusInput): void {
    this.runtimes.set(botId, runtime);
  }

  private closeSubscription(botId: string): void {
    const subscription = this.subscriptions.get(botId);
    if (!subscription) {
      return;
    }
    subscription.close();
    this.subscriptions.delete(botId);
  }

  private requireStoredBot(botId?: string | null): StoredLarkChannelBot {
    const storedBot = this.store.getBot(botId);
    if (!storedBot) {
      throw new Error("Lark bot not found");
    }
    return storedBot;
  }

  private isTargetConfigured(config: StoredLarkChannelConfig): boolean {
    const target = config.target;
    if (target.kind === "workspace") {
      return Boolean(target.provider && target.cwd);
    }
    // For assistant targets, provider defaults to "claude" at resolve time,
    // so we only require assistantId and cwd.
    return Boolean(target.assistantId && target.cwd);
  }

  private evictDedupe(now: number): void {
    for (const [key, expiresAt] of this.eventDedupe) {
      if (expiresAt <= now) {
        this.eventDedupe.delete(key);
      }
    }
  }

  private emitStatusChanged(): void {
    this.host.emitStatusChanged(this.getStatus());
  }
}
