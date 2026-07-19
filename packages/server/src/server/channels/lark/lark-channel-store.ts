import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type pino from "pino";
import { z } from "zod";
import {
  LarkChannelAuthorizedUserSchema,
  LarkChannelDomainSchema,
  LarkChannelPendingPairingSchema,
  LarkChannelStatusSchema,
  LarkChannelTargetSchema,
  type LarkChannelAuthorizedUser,
  type LarkChannelBot,
  type LarkChannelBotStatus,
  type LarkChannelConnectionStatus,
  type LarkChannelPendingPairing,
  type LarkChannelStatus,
  type LarkChannelTarget,
} from "@getpaseo/protocol/messages";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "../../private-files.js";

const LARK_CHANNEL_STORE_VERSION = 3;
const LEGACY_DEFAULT_BOT_ID = "default";

const StoredLarkChannelConfigSchema = z.object({
  enabled: z.boolean(),
  appId: z.string().nullable(),
  appSecret: z.string().nullable(),
  encryptKey: z.string().nullable(),
  verificationToken: z.string().nullable(),
  domain: LarkChannelDomainSchema,
  target: LarkChannelTargetSchema,
});

export type StoredLarkChannelConfig = z.infer<typeof StoredLarkChannelConfigSchema>;

const LarkChannelConversationSchema = z.object({
  chatId: z.string(),
  threadId: z.string(),
  rootMessageId: z.string().nullable(),
  userId: z.string(),
  agentId: z.string(),
  title: z.string(),
  createdAt: z.string(),
  lastInboundAt: z.string(),
  lastOutboundAt: z.string().nullable(),
});

export type LarkChannelConversation = z.infer<typeof LarkChannelConversationSchema>;

const StoredLarkChannelBotSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable(),
  config: StoredLarkChannelConfigSchema,
  authorizedUsers: z.array(LarkChannelAuthorizedUserSchema),
  pendingPairings: z.array(LarkChannelPendingPairingSchema),
  conversations: z.array(LarkChannelConversationSchema),
});

export type StoredLarkChannelBot = z.infer<typeof StoredLarkChannelBotSchema>;

const LarkChannelStorePayloadSchema = z.object({
  version: z.literal(LARK_CHANNEL_STORE_VERSION),
  activeBotId: z.string().nullable(),
  bots: z.array(StoredLarkChannelBotSchema),
});

export type LarkChannelStorePayload = z.infer<typeof LarkChannelStorePayloadSchema>;

const LegacyLarkChannelTargetSchema = z.object({
  kind: z.literal("agent"),
  agentId: z.string().nullable(),
});

const LegacyStoredLarkChannelConfigSchema = StoredLarkChannelConfigSchema.extend({
  target: z.union([LarkChannelTargetSchema, LegacyLarkChannelTargetSchema]),
});

const LegacyLarkChannelConversationSchema = z.object({
  chatId: z.string(),
  userId: z.string(),
  agentId: z.string(),
  lastInboundAt: z.string(),
  lastOutboundAt: z.string().nullable(),
});

const LegacyStoredLarkChannelBotSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable().optional(),
  config: LegacyStoredLarkChannelConfigSchema,
  authorizedUsers: z.array(LarkChannelAuthorizedUserSchema),
  pendingPairings: z.array(LarkChannelPendingPairingSchema),
  conversations: z.array(
    z.union([LarkChannelConversationSchema, LegacyLarkChannelConversationSchema]),
  ),
});

const LegacyLarkChannelStorePayloadV3Schema = z.object({
  version: z.literal(LARK_CHANNEL_STORE_VERSION),
  activeBotId: z.string().nullable().optional(),
  bots: z.array(LegacyStoredLarkChannelBotSchema),
});

const LegacyLarkChannelStorePayloadV2Schema = z.object({
  version: z.number(),
  config: LegacyStoredLarkChannelConfigSchema,
  authorizedUsers: z.array(LarkChannelAuthorizedUserSchema),
  pendingPairings: z.array(LarkChannelPendingPairingSchema),
  conversations: z.array(
    z.union([LarkChannelConversationSchema, LegacyLarkChannelConversationSchema]),
  ),
});

export interface LarkChannelRuntimeStatusInput {
  connectionStatus: LarkChannelConnectionStatus;
  error: string | null;
  bot: LarkChannelBot | null;
}

export interface LarkChannelStoreStatusInput {
  byBotId?: Map<string, LarkChannelRuntimeStatusInput>;
}

export interface ConfigureLarkChannelStoreInput {
  botId?: string;
  name?: string;
  createNew?: boolean;
  appId?: string;
  appSecret?: string;
  encryptKey?: string;
  verificationToken?: string;
  clearEncryptKey?: boolean;
  clearVerificationToken?: boolean;
  domain?: StoredLarkChannelConfig["domain"];
  target?: LarkChannelTarget;
}

export interface UpsertLarkPendingPairingInput {
  openId: string | null;
  unionId: string | null;
  chatId: string;
  displayName: string;
  createdAt: string;
  expiresAt: string;
}

export interface RecordLarkThreadConversationInput {
  chatId: string;
  threadId: string;
  rootMessageId: string | null;
  userId: string;
  agentId: string;
  title: string;
  now: string;
}

function createDefaultTarget(): LarkChannelTarget {
  return {
    kind: "workspace",
    provider: null,
    model: null,
    cwd: null,
    workspaceId: null,
  };
}

function createDefaultConfig(): StoredLarkChannelConfig {
  return {
    enabled: false,
    appId: null,
    appSecret: null,
    encryptKey: null,
    verificationToken: null,
    domain: "feishu",
    target: createDefaultTarget(),
  };
}

function createStoredBot(input: { id?: string; name?: string | null } = {}): StoredLarkChannelBot {
  return {
    id: input.id ?? randomUUID(),
    name: trimToNull(input.name),
    config: createDefaultConfig(),
    authorizedUsers: [],
    pendingPairings: [],
    conversations: [],
  };
}

function createDefaultPayload(): LarkChannelStorePayload {
  return {
    version: LARK_CHANNEL_STORE_VERSION,
    activeBotId: null,
    bots: [],
  };
}

function trimToNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function clonePayload(payload: LarkChannelStorePayload): LarkChannelStorePayload {
  return LarkChannelStorePayloadSchema.parse(JSON.parse(JSON.stringify(payload)));
}

function cloneBot(bot: StoredLarkChannelBot): StoredLarkChannelBot {
  return StoredLarkChannelBotSchema.parse(JSON.parse(JSON.stringify(bot)));
}

function sameLarkIdentity(
  user: { openId: string | null; unionId: string | null; chatId: string },
  other: { openId: string | null; unionId: string | null; chatId: string },
): boolean {
  if (user.openId && other.openId && user.openId === other.openId) {
    return true;
  }
  if (user.unionId && other.unionId && user.unionId === other.unionId) {
    return true;
  }
  return user.chatId === other.chatId;
}

function normalizeTarget(
  target: z.infer<typeof LegacyStoredLarkChannelConfigSchema>["target"],
): LarkChannelTarget {
  if (target.kind === "workspace" || target.kind === "assistant") {
    return target;
  }
  return createDefaultTarget();
}

function normalizeConversation(
  conversation: z.infer<typeof LegacyLarkChannelStorePayloadV2Schema>["conversations"][number],
): LarkChannelConversation | null {
  if ("threadId" in conversation) {
    return conversation;
  }
  return null;
}

function normalizeBot(bot: z.infer<typeof LegacyStoredLarkChannelBotSchema>): StoredLarkChannelBot {
  const conversations = bot.conversations
    .map((conversation) => normalizeConversation(conversation))
    .filter((conversation): conversation is LarkChannelConversation => conversation !== null);
  return StoredLarkChannelBotSchema.parse({
    id: bot.id,
    name: trimToNull(bot.name),
    config: {
      ...bot.config,
      target: normalizeTarget(bot.config.target),
    },
    authorizedUsers: bot.authorizedUsers,
    pendingPairings: bot.pendingPairings,
    conversations,
  });
}

function normalizeActiveBotId(
  activeBotId: string | null | undefined,
  bots: StoredLarkChannelBot[],
): string | null {
  if (activeBotId && bots.some((bot) => bot.id === activeBotId)) {
    return activeBotId;
  }
  return bots[0]?.id ?? null;
}

function normalizePayload(raw: unknown): LarkChannelStorePayload {
  const parsedV3 = LegacyLarkChannelStorePayloadV3Schema.safeParse(raw);
  if (parsedV3.success) {
    const bots = parsedV3.data.bots.map((bot) => normalizeBot(bot));
    return LarkChannelStorePayloadSchema.parse({
      version: LARK_CHANNEL_STORE_VERSION,
      activeBotId: normalizeActiveBotId(parsedV3.data.activeBotId ?? null, bots),
      bots,
    });
  }

  const parsedV2 = LegacyLarkChannelStorePayloadV2Schema.parse(raw);
  const legacyBot = normalizeBot({
    id: LEGACY_DEFAULT_BOT_ID,
    name: null,
    config: parsedV2.config,
    authorizedUsers: parsedV2.authorizedUsers,
    pendingPairings: parsedV2.pendingPairings,
    conversations: parsedV2.conversations,
  });
  return LarkChannelStorePayloadSchema.parse({
    version: LARK_CHANNEL_STORE_VERSION,
    activeBotId: legacyBot.id,
    bots: [legacyBot],
  });
}

function getRuntimeForBot(
  bot: StoredLarkChannelBot,
  input: LarkChannelStoreStatusInput,
): LarkChannelRuntimeStatusInput {
  return (
    input.byBotId?.get(bot.id) ?? {
      connectionStatus: bot.config.enabled ? "idle" : "disabled",
      error: null,
      bot: null,
    }
  );
}

function buildBotStatus(
  bot: StoredLarkChannelBot,
  runtime: LarkChannelRuntimeStatusInput,
): LarkChannelBotStatus {
  return {
    id: bot.id,
    name: bot.name,
    enabled: bot.config.enabled,
    connectionStatus: runtime.connectionStatus,
    error: runtime.error,
    appId: bot.config.appId,
    hasAppSecret: Boolean(bot.config.appSecret),
    hasEncryptKey: Boolean(bot.config.encryptKey),
    hasVerificationToken: Boolean(bot.config.verificationToken),
    domain: bot.config.domain,
    target: bot.config.target,
    bot: runtime.bot,
    pendingPairings: bot.pendingPairings,
    authorizedUsers: bot.authorizedUsers,
  };
}

function buildEmptyStatus(): Omit<LarkChannelStatus, "activeBotId" | "bots"> {
  return {
    enabled: false,
    connectionStatus: "disabled",
    error: null,
    appId: null,
    hasAppSecret: false,
    hasEncryptKey: false,
    hasVerificationToken: false,
    domain: "feishu",
    target: createDefaultTarget(),
    bot: null,
    pendingPairings: [],
    authorizedUsers: [],
  };
}

export class LarkChannelStore {
  private readonly filePath: string;
  private readonly logger: pino.Logger;
  private loaded = false;
  private payload: LarkChannelStorePayload = createDefaultPayload();

  constructor(options: { paseoHome: string; logger: pino.Logger }) {
    this.filePath = path.join(options.paseoHome, "channels", "lark.json");
    this.logger = options.logger.child({ module: "lark-channel-store" });
  }

  getFilePath(): string {
    return this.filePath;
  }

  getPayload(): LarkChannelStorePayload {
    this.ensureLoaded();
    return clonePayload(this.payload);
  }

  getBots(): StoredLarkChannelBot[] {
    return this.getPayload().bots;
  }

  getBot(botId?: string | null): StoredLarkChannelBot | null {
    this.ensureLoaded();
    const bot = this.resolveBot(this.payload, botId);
    return bot ? cloneBot(bot) : null;
  }

  getConfig(botId?: string | null): StoredLarkChannelConfig {
    return this.getBot(botId)?.config ?? createDefaultConfig();
  }

  getStatus(input: LarkChannelStoreStatusInput = {}): LarkChannelStatus {
    this.ensureLoaded();
    const bots = this.payload.bots.map((bot) => buildBotStatus(bot, getRuntimeForBot(bot, input)));
    const activeBotId = normalizeActiveBotId(this.payload.activeBotId, this.payload.bots);
    const activeStatus = bots.find((bot) => bot.id === activeBotId) ?? bots[0] ?? null;
    const base = activeStatus
      ? {
          enabled: activeStatus.enabled,
          connectionStatus: activeStatus.connectionStatus,
          error: activeStatus.error,
          appId: activeStatus.appId,
          hasAppSecret: activeStatus.hasAppSecret,
          hasEncryptKey: activeStatus.hasEncryptKey,
          hasVerificationToken: activeStatus.hasVerificationToken,
          domain: activeStatus.domain,
          target: activeStatus.target,
          bot: activeStatus.bot,
          pendingPairings: activeStatus.pendingPairings,
          authorizedUsers: activeStatus.authorizedUsers,
        }
      : buildEmptyStatus();
    return LarkChannelStatusSchema.parse({
      ...base,
      activeBotId,
      bots,
    });
  }

  configure(input: ConfigureLarkChannelStoreInput): StoredLarkChannelBot {
    this.ensureLoaded();
    const next: LarkChannelStorePayload = clonePayload(this.payload);
    const index = this.resolveConfigureIndex(next, input);
    const bot = next.bots[index]!;

    if (input.name !== undefined) {
      bot.name = trimToNull(input.name);
    }
    const appId = trimToNull(input.appId);
    if (appId) {
      bot.config.appId = appId;
    }
    const appSecret = trimToNull(input.appSecret);
    if (appSecret) {
      bot.config.appSecret = appSecret;
    }
    const encryptKey = trimToNull(input.encryptKey);
    if (encryptKey) {
      bot.config.encryptKey = encryptKey;
    } else if (input.clearEncryptKey) {
      bot.config.encryptKey = null;
    }
    const verificationToken = trimToNull(input.verificationToken);
    if (verificationToken) {
      bot.config.verificationToken = verificationToken;
    } else if (input.clearVerificationToken) {
      bot.config.verificationToken = null;
    }
    if (input.domain) {
      bot.config.domain = input.domain;
    }
    if (input.target) {
      bot.config.target = input.target;
    }
    next.activeBotId = bot.id;
    this.replaceAndPersist(next);
    return this.getBot(bot.id)!;
  }

  deleteBot(botId: string): boolean {
    this.ensureLoaded();
    const next = clonePayload(this.payload);
    const remaining = next.bots.filter((bot) => bot.id !== botId);
    if (remaining.length === next.bots.length) {
      return false;
    }
    next.bots = remaining;
    next.activeBotId = normalizeActiveBotId(
      next.activeBotId === botId ? null : next.activeBotId,
      next.bots,
    );
    this.replaceAndPersist(next);
    return true;
  }

  setEnabled(botId: string | null | undefined, enabled: boolean): StoredLarkChannelBot {
    this.ensureLoaded();
    const next = clonePayload(this.payload);
    const index = this.requireBotIndex(next, botId);
    next.bots[index]!.config.enabled = enabled;
    next.activeBotId = next.bots[index]!.id;
    this.replaceAndPersist(next);
    return this.getBot(next.activeBotId)!;
  }

  upsertPendingPairing(
    botId: string | null | undefined,
    input: UpsertLarkPendingPairingInput,
  ): LarkChannelPendingPairing {
    this.ensureLoaded();
    const next = clonePayload(this.payload);
    const index = this.requireBotIndex(next, botId);
    const bot = next.bots[index]!;
    const existingIndex = bot.pendingPairings.findIndex((pairing) =>
      sameLarkIdentity(pairing, input),
    );
    const pairing: LarkChannelPendingPairing = {
      code:
        existingIndex >= 0 ? bot.pendingPairings[existingIndex]!.code : randomUUID().slice(0, 8),
      openId: input.openId,
      unionId: input.unionId,
      chatId: input.chatId,
      displayName: input.displayName,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    };
    if (existingIndex >= 0) {
      bot.pendingPairings[existingIndex] = pairing;
    } else {
      bot.pendingPairings.push(pairing);
    }
    this.replaceAndPersist(next);
    return pairing;
  }

  approvePairing(
    botId: string | null | undefined,
    code: string,
    authorizedAt: string,
  ): LarkChannelAuthorizedUser | null {
    this.ensureLoaded();
    const next = clonePayload(this.payload);
    const index = this.requireBotIndex(next, botId);
    const bot = next.bots[index]!;
    const pairingIndex = bot.pendingPairings.findIndex((pairing) => pairing.code === code);
    if (pairingIndex < 0) {
      return null;
    }
    const [pairing] = bot.pendingPairings.splice(pairingIndex, 1);
    const existingIndex = bot.authorizedUsers.findIndex((user) => sameLarkIdentity(user, pairing));
    const user: LarkChannelAuthorizedUser = {
      id: existingIndex >= 0 ? bot.authorizedUsers[existingIndex]!.id : randomUUID(),
      openId: pairing.openId,
      unionId: pairing.unionId,
      chatId: pairing.chatId,
      displayName: pairing.displayName,
      authorizedAt,
    };
    if (existingIndex >= 0) {
      bot.authorizedUsers[existingIndex] = user;
    } else {
      bot.authorizedUsers.push(user);
    }
    this.replaceAndPersist(next);
    return user;
  }

  rejectPairing(botId: string | null | undefined, code: string): boolean {
    this.ensureLoaded();
    const next = clonePayload(this.payload);
    const index = this.requireBotIndex(next, botId);
    const bot = next.bots[index]!;
    const remaining = bot.pendingPairings.filter((pairing) => pairing.code !== code);
    if (remaining.length === bot.pendingPairings.length) {
      return false;
    }
    bot.pendingPairings = remaining;
    this.replaceAndPersist(next);
    return true;
  }

  revokeUser(botId: string | null | undefined, userId: string): boolean {
    this.ensureLoaded();
    const next = clonePayload(this.payload);
    const index = this.requireBotIndex(next, botId);
    const bot = next.bots[index]!;
    const remaining = bot.authorizedUsers.filter((user) => user.id !== userId);
    if (remaining.length === bot.authorizedUsers.length) {
      return false;
    }
    bot.authorizedUsers = remaining;
    bot.conversations = bot.conversations.filter((conversation) => conversation.userId !== userId);
    this.replaceAndPersist(next);
    return true;
  }

  findAuthorizedUser(
    botId: string | null | undefined,
    input: {
      openId: string | null;
      unionId: string | null;
      chatId: string;
    },
  ): LarkChannelAuthorizedUser | null {
    this.ensureLoaded();
    const bot = this.resolveBot(this.payload, botId);
    return bot?.authorizedUsers.find((user) => sameLarkIdentity(user, input)) ?? null;
  }

  findConversationByThread(
    botId: string | null | undefined,
    chatId: string,
    threadId: string,
  ): LarkChannelConversation | null {
    this.ensureLoaded();
    const bot = this.resolveBot(this.payload, botId);
    return (
      bot?.conversations.find(
        (conversation) => conversation.chatId === chatId && conversation.threadId === threadId,
      ) ?? null
    );
  }

  recordThreadConversation(
    botId: string | null | undefined,
    input: RecordLarkThreadConversationInput,
  ): void {
    this.ensureLoaded();
    const next = clonePayload(this.payload);
    const botIndex = this.requireBotIndex(next, botId);
    const bot = next.bots[botIndex]!;
    const index = bot.conversations.findIndex(
      (conversation) =>
        conversation.chatId === input.chatId && conversation.threadId === input.threadId,
    );
    const record: LarkChannelConversation = {
      chatId: input.chatId,
      threadId: input.threadId,
      rootMessageId: input.rootMessageId,
      userId: input.userId,
      agentId: input.agentId,
      title: input.title,
      createdAt: index >= 0 ? bot.conversations[index]!.createdAt : input.now,
      lastInboundAt: input.now,
      lastOutboundAt: index >= 0 ? bot.conversations[index]!.lastOutboundAt : null,
    };
    if (index >= 0) {
      bot.conversations[index] = record;
    } else {
      bot.conversations.push(record);
    }
    this.replaceAndPersist(next);
  }

  markConversationOutbound(
    botId: string | null | undefined,
    agentId: string,
    chatId: string,
    threadId: string,
    outboundAt: string,
  ): void {
    this.ensureLoaded();
    const next = clonePayload(this.payload);
    const botIndex = this.requireBotIndex(next, botId);
    const bot = next.bots[botIndex]!;
    const index = bot.conversations.findIndex(
      (conversation) =>
        conversation.agentId === agentId &&
        conversation.chatId === chatId &&
        conversation.threadId === threadId,
    );
    if (index < 0) {
      return;
    }
    bot.conversations[index] = {
      ...bot.conversations[index]!,
      lastOutboundAt: outboundAt,
    };
    this.replaceAndPersist(next);
  }

  cleanupExpiredPairings(nowIso: string): boolean {
    this.ensureLoaded();
    const now = Date.parse(nowIso);
    const next = clonePayload(this.payload);
    let changed = false;
    next.bots = next.bots.map((bot) => {
      const pendingPairings = bot.pendingPairings.filter(
        (pairing) => Date.parse(pairing.expiresAt) > now,
      );
      if (pendingPairings.length !== bot.pendingPairings.length) {
        changed = true;
      }
      return { ...bot, pendingPairings };
    });
    if (!changed) {
      return false;
    }
    this.replaceAndPersist(next);
    return true;
  }

  private resolveConfigureIndex(
    payload: LarkChannelStorePayload,
    input: ConfigureLarkChannelStoreInput,
  ): number {
    if (input.createNew) {
      payload.bots.push(createStoredBot({ name: input.name }));
      return payload.bots.length - 1;
    }
    if (input.botId) {
      const index = payload.bots.findIndex((bot) => bot.id === input.botId);
      if (index < 0) {
        throw new Error("Lark bot not found");
      }
      return index;
    }
    const activeIndex = this.findActiveBotIndex(payload);
    if (activeIndex >= 0) {
      return activeIndex;
    }
    payload.bots.push(createStoredBot({ name: input.name }));
    return payload.bots.length - 1;
  }

  private requireBotIndex(payload: LarkChannelStorePayload, botId?: string | null): number {
    if (botId) {
      const index = payload.bots.findIndex((bot) => bot.id === botId);
      if (index >= 0) {
        return index;
      }
      throw new Error("Lark bot not found");
    }
    const activeIndex = this.findActiveBotIndex(payload);
    if (activeIndex >= 0) {
      return activeIndex;
    }
    payload.bots.push(createStoredBot());
    payload.activeBotId = payload.bots[payload.bots.length - 1]!.id;
    return payload.bots.length - 1;
  }

  private findActiveBotIndex(payload: LarkChannelStorePayload): number {
    if (payload.activeBotId) {
      const activeIndex = payload.bots.findIndex((bot) => bot.id === payload.activeBotId);
      if (activeIndex >= 0) {
        return activeIndex;
      }
    }
    return payload.bots.length > 0 ? 0 : -1;
  }

  private resolveBot(
    payload: LarkChannelStorePayload,
    botId?: string | null,
  ): StoredLarkChannelBot | null {
    if (botId) {
      return payload.bots.find((bot) => bot.id === botId) ?? null;
    }
    const activeIndex = this.findActiveBotIndex(payload);
    return activeIndex >= 0 ? payload.bots[activeIndex]! : null;
  }

  private ensureLoaded(): void {
    if (this.loaded) {
      return;
    }
    if (!existsSync(this.filePath)) {
      this.payload = createDefaultPayload();
      this.loaded = true;
      return;
    }
    ensurePrivateFile(this.filePath);
    const raw = readFileSync(this.filePath, "utf8");
    try {
      this.payload = normalizePayload(JSON.parse(raw));
    } catch (error) {
      this.logger.error(
        { err: error, filePath: this.filePath },
        "Failed to parse Lark channel store",
      );
      throw error;
    }
    this.loaded = true;
  }

  private replaceAndPersist(payload: LarkChannelStorePayload): void {
    const activeBotId = normalizeActiveBotId(payload.activeBotId, payload.bots);
    const parsed = LarkChannelStorePayloadSchema.parse({ ...payload, activeBotId });
    writePrivateFileAtomicSync(this.filePath, JSON.stringify(parsed, null, 2));
    this.payload = parsed;
    this.loaded = true;
  }
}
