import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type pino from "pino";
import { AssistantStore } from "./assistant-store.js";

export type AssistantSessionRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "assistant.list.request"
      | "assistant.create.request"
      | "assistant.update.request"
      | "assistant.delete.request";
  }
>;

export interface AssistantSessionHost {
  emit(message: SessionOutboundMessage): void;
}

export interface AssistantSessionOptions {
  host: AssistantSessionHost;
  store: AssistantStore;
  logger: pino.Logger;
}

export class AssistantSession {
  private readonly host: AssistantSessionHost;
  private readonly store: AssistantStore;
  private readonly logger: pino.Logger;

  constructor(options: AssistantSessionOptions) {
    this.host = options.host;
    this.store = options.store;
    this.logger = options.logger.child({ module: "assistant-session" });
  }

  async handleRequest(message: AssistantSessionRequest): Promise<void> {
    try {
      switch (message.type) {
        case "assistant.list.request":
          this.host.emit({
            type: "assistant.list.response",
            payload: {
              requestId: message.requestId,
              assistants: this.store.list(),
              error: null,
            },
          });
          return;
        case "assistant.create.request": {
          const assistant = this.store.create(message.assistant);
          this.emitChanged();
          this.host.emit({
            type: "assistant.create.response",
            payload: { requestId: message.requestId, assistant, error: null },
          });
          return;
        }
        case "assistant.update.request": {
          const assistant = this.store.update(message.assistant);
          if (!assistant) {
            this.host.emit({
              type: "assistant.update.response",
              payload: {
                requestId: message.requestId,
                assistant: null,
                error: "Assistant not found",
              },
            });
            return;
          }
          this.emitChanged();
          this.host.emit({
            type: "assistant.update.response",
            payload: { requestId: message.requestId, assistant, error: null },
          });
          return;
        }
        case "assistant.delete.request": {
          const ok = this.store.delete(message.id);
          if (ok) {
            this.emitChanged();
          }
          this.host.emit({
            type: "assistant.delete.response",
            payload: {
              requestId: message.requestId,
              id: message.id,
              ok,
              error: ok ? null : "Assistant not found",
            },
          });
          return;
        }
      }
    } catch (error) {
      this.logger.warn({ err: error, requestType: message.type }, "Assistant RPC failed");
      this.emitErrorResponse(message, error instanceof Error ? error.message : String(error));
    }
  }

  private emitChanged(): void {
    this.host.emit({
      type: "assistant.changed",
      payload: { assistants: this.store.list() },
    });
  }

  private emitErrorResponse(message: AssistantSessionRequest, error: string): void {
    switch (message.type) {
      case "assistant.list.request":
        this.host.emit({
          type: "assistant.list.response",
          payload: { requestId: message.requestId, assistants: this.store.list(), error },
        });
        return;
      case "assistant.create.request":
        this.host.emit({
          type: "assistant.create.response",
          payload: { requestId: message.requestId, assistant: null, error },
        });
        return;
      case "assistant.update.request":
        this.host.emit({
          type: "assistant.update.response",
          payload: { requestId: message.requestId, assistant: null, error },
        });
        return;
      case "assistant.delete.request":
        this.host.emit({
          type: "assistant.delete.response",
          payload: { requestId: message.requestId, id: message.id, ok: false, error },
        });
        return;
    }
  }
}
