import * as lark from "@larksuiteoapi/node-sdk";
import type pino from "pino";
import type { StoredLarkChannelConfig } from "./lark-channel-store.js";
import {
  normalizeLarkMessageEvent,
  type NormalizedLarkMessageEvent,
} from "./lark-message-format.js";

export interface LarkChannelBotInfo {
  name?: string;
  avatarUrl?: string;
}

export interface LarkChannelEventSubscription {
  close(): void;
}

export interface LarkThreadReplyResult {
  threadId: string | null;
  messageId: string | null;
}

export interface LarkChannelClientAdapter {
  testConnection(config: StoredLarkChannelConfig): Promise<LarkChannelBotInfo | null>;
  startEvents(
    config: StoredLarkChannelConfig,
    handler: (event: NormalizedLarkMessageEvent) => Promise<void>,
  ): Promise<LarkChannelEventSubscription>;
  sendText(config: StoredLarkChannelConfig, chatId: string, text: string): Promise<void>;
  replyToMessageInThread(
    config: StoredLarkChannelConfig,
    messageId: string,
    text: string,
  ): Promise<LarkThreadReplyResult>;
  replyInThread(config: StoredLarkChannelConfig, messageId: string, text: string): Promise<void>;
}

function requireCredentials(config: StoredLarkChannelConfig): { appId: string; appSecret: string } {
  if (!config.appId || !config.appSecret) {
    throw new Error("Lark App ID and App Secret are required");
  }
  return { appId: config.appId, appSecret: config.appSecret };
}

function resolveDomain(domain: StoredLarkChannelConfig["domain"]): lark.Domain {
  return domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
}

function createClient(config: StoredLarkChannelConfig): lark.Client {
  const credentials = requireCredentials(config);
  return new lark.Client({
    ...credentials,
    appType: lark.AppType.SelfBuild,
    domain: resolveDomain(config.domain),
  });
}

function describeLarkError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function assertSuccess(result: { code?: number; msg?: string }): void {
  if (typeof result.code === "number" && result.code !== 0) {
    throw describeLarkError(new Error(result.msg ?? `Lark API returned code ${result.code}`));
  }
}

export class OfficialLarkChannelClientAdapter implements LarkChannelClientAdapter {
  private readonly logger: pino.Logger;

  constructor(options: { logger: pino.Logger }) {
    this.logger = options.logger.child({ module: "lark-client-adapter" });
  }

  async testConnection(config: StoredLarkChannelConfig): Promise<LarkChannelBotInfo | null> {
    const credentials = requireCredentials(config);
    const client = createClient(config);
    const result = await client.auth.v3.tenantAccessToken.internal({
      data: {
        app_id: credentials.appId,
        app_secret: credentials.appSecret,
      },
    });
    assertSuccess(result);
    return null;
  }

  async startEvents(
    config: StoredLarkChannelConfig,
    handler: (event: NormalizedLarkMessageEvent) => Promise<void>,
  ): Promise<LarkChannelEventSubscription> {
    const credentials = requireCredentials(config);
    const wsClient = new lark.WSClient({
      ...credentials,
      domain: resolveDomain(config.domain),
      loggerLevel: lark.LoggerLevel.info,
      onError: (err) => {
        this.logger.error({ err, appId: credentials.appId }, "Lark WebSocket client error");
      },
      onReady: () => {
        this.logger.info({ appId: credentials.appId }, "Lark WebSocket client ready");
      },
    });
    const dispatcher = new lark.EventDispatcher({
      encryptKey: config.encryptKey ?? undefined,
      verificationToken: config.verificationToken ?? undefined,
    }).register({
      "im.message.receive_v1": async (event: unknown) => {
        const normalized = normalizeLarkMessageEvent(event);
        if (!normalized) {
          this.logger.debug({ event }, "Ignoring unsupported Lark event");
          return;
        }
        await handler(normalized);
      },
    });
    await wsClient.start({ eventDispatcher: dispatcher });
    this.logger.info(
      { appId: credentials.appId, domain: config.domain },
      "Lark WebSocket event subscription started",
    );
    return {
      close: () => {
        wsClient.close({ force: true });
      },
    };
  }

  async sendText(config: StoredLarkChannelConfig, chatId: string, text: string): Promise<void> {
    const client = createClient(config);
    const result = await client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    assertSuccess(result);
  }

  async replyToMessageInThread(
    config: StoredLarkChannelConfig,
    messageId: string,
    text: string,
  ): Promise<LarkThreadReplyResult> {
    const client = createClient(config);
    const result = await client.im.v1.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text }),
        reply_in_thread: true,
      },
    });
    assertSuccess(result);
    return {
      threadId: result.data?.thread_id ?? null,
      messageId: result.data?.message_id ?? null,
    };
  }

  async replyInThread(
    config: StoredLarkChannelConfig,
    messageId: string,
    text: string,
  ): Promise<void> {
    const client = createClient(config);
    const result = await client.im.v1.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text }),
        reply_in_thread: true,
      },
    });
    assertSuccess(result);
  }
}
