import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type pino from "pino";
import { LarkChannelService } from "./lark-channel-service.js";

export type LarkChannelSessionRequest = Extract<
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

type LarkChannelResponse = Extract<
  SessionOutboundMessage,
  {
    type:
      | "channel.lark.get_status.response"
      | "channel.lark.configure.response"
      | "channel.lark.delete_bot.response"
      | "channel.lark.test_connection.response"
      | "channel.lark.set_enabled.response"
      | "channel.lark.approve_pairing.response"
      | "channel.lark.reject_pairing.response"
      | "channel.lark.revoke_user.response";
  }
>;

export interface LarkChannelSessionHost {
  emit(message: SessionOutboundMessage): void;
}

export class LarkChannelSession {
  private readonly host: LarkChannelSessionHost;
  private readonly service: LarkChannelService;
  private readonly logger: pino.Logger;

  constructor(options: {
    host: LarkChannelSessionHost;
    service: LarkChannelService;
    logger: pino.Logger;
  }) {
    this.host = options.host;
    this.service = options.service;
    this.logger = options.logger.child({ module: "lark-channel-session" });
  }

  async handleRequest(message: LarkChannelSessionRequest): Promise<void> {
    try {
      switch (message.type) {
        case "channel.lark.get_status.request":
          this.emitResponse({
            type: "channel.lark.get_status.response",
            payload: {
              requestId: message.requestId,
              status: this.service.getStatus(),
              error: null,
            },
          });
          return;
        case "channel.lark.configure.request":
          this.emitResponse({
            type: "channel.lark.configure.response",
            payload: {
              requestId: message.requestId,
              status: await this.service.configure({
                appId: message.appId,
                botId: message.botId,
                name: message.name,
                createNew: message.createNew,
                appSecret: message.appSecret,
                encryptKey: message.encryptKey,
                verificationToken: message.verificationToken,
                clearEncryptKey: message.clearEncryptKey,
                clearVerificationToken: message.clearVerificationToken,
                domain: message.domain,
                target: message.target,
              }),
              error: null,
            },
          });
          return;
        case "channel.lark.delete_bot.request":
          this.emitResponse({
            type: "channel.lark.delete_bot.response",
            payload: {
              requestId: message.requestId,
              status: await this.service.deleteBot(message.botId),
              error: null,
            },
          });
          return;
        case "channel.lark.test_connection.request":
          this.emitResponse({
            type: "channel.lark.test_connection.response",
            payload: {
              requestId: message.requestId,
              status: await this.service.testConnection(message.botId),
              error: null,
            },
          });
          return;
        case "channel.lark.set_enabled.request":
          this.emitResponse({
            type: "channel.lark.set_enabled.response",
            payload: {
              requestId: message.requestId,
              status: await this.service.setEnabled(message.enabled, message.botId),
              error: null,
            },
          });
          return;
        case "channel.lark.approve_pairing.request":
          this.emitResponse({
            type: "channel.lark.approve_pairing.response",
            payload: {
              requestId: message.requestId,
              status: this.service.approvePairing(message.code, message.botId),
              error: null,
            },
          });
          return;
        case "channel.lark.reject_pairing.request":
          this.emitResponse({
            type: "channel.lark.reject_pairing.response",
            payload: {
              requestId: message.requestId,
              status: this.service.rejectPairing(message.code, message.botId),
              error: null,
            },
          });
          return;
        case "channel.lark.revoke_user.request":
          this.emitResponse({
            type: "channel.lark.revoke_user.response",
            payload: {
              requestId: message.requestId,
              status: this.service.revokeUser(message.userId, message.botId),
              error: null,
            },
          });
          return;
      }
    } catch (error) {
      this.logger.warn({ err: error, requestType: message.type }, "Lark channel RPC failed");
      this.emitErrorResponse(message, error instanceof Error ? error.message : String(error));
    }
  }

  private emitResponse(message: LarkChannelResponse): void {
    this.host.emit(message);
  }

  private emitErrorResponse(message: LarkChannelSessionRequest, error: string): void {
    const payload = {
      requestId: message.requestId,
      status: this.service.getStatus(),
      error,
    };
    switch (message.type) {
      case "channel.lark.get_status.request":
        this.emitResponse({ type: "channel.lark.get_status.response", payload });
        return;
      case "channel.lark.configure.request":
        this.emitResponse({ type: "channel.lark.configure.response", payload });
        return;
      case "channel.lark.delete_bot.request":
        this.emitResponse({ type: "channel.lark.delete_bot.response", payload });
        return;
      case "channel.lark.test_connection.request":
        this.emitResponse({ type: "channel.lark.test_connection.response", payload });
        return;
      case "channel.lark.set_enabled.request":
        this.emitResponse({ type: "channel.lark.set_enabled.response", payload });
        return;
      case "channel.lark.approve_pairing.request":
        this.emitResponse({ type: "channel.lark.approve_pairing.response", payload });
        return;
      case "channel.lark.reject_pairing.request":
        this.emitResponse({ type: "channel.lark.reject_pairing.response", payload });
        return;
      case "channel.lark.revoke_user.request":
        this.emitResponse({ type: "channel.lark.revoke_user.response", payload });
        return;
    }
  }
}
