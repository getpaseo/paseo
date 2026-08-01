import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { UiStateStore } from "./store.js";

interface UiStateSessionHost {
  emit: (message: SessionOutboundMessage) => void;
  /** Broadcast to other connected sessions (not this one). */
  broadcast: (message: SessionOutboundMessage) => void;
}

export class UiStateSession {
  constructor(
    private readonly options: {
      host: UiStateSessionHost;
      store: UiStateStore;
    },
  ) {}

  async handleGet(
    request: Extract<SessionInboundMessage, { type: "ui_state.get.request" }>,
  ): Promise<void> {
    try {
      const record = await this.options.store.get({
        namespace: request.namespace,
        key: request.key,
      });
      this.options.host.emit({
        type: "ui_state.get.response",
        payload: {
          requestId: request.requestId,
          namespace: request.namespace,
          key: request.key,
          record,
          error: null,
        },
      });
    } catch (error) {
      this.options.host.emit({
        type: "ui_state.get.response",
        payload: {
          requestId: request.requestId,
          namespace: request.namespace,
          key: request.key,
          record: null,
          error: getErrorMessage(error),
        },
      });
    }
  }

  async handleUpsert(
    request: Extract<SessionInboundMessage, { type: "ui_state.upsert.request" }>,
  ): Promise<void> {
    try {
      const result = await this.options.store.upsert({
        namespace: request.namespace,
        key: request.key,
        record: request.record,
      });
      this.options.host.emit({
        type: "ui_state.upsert.response",
        payload: {
          requestId: request.requestId,
          namespace: request.namespace,
          key: request.key,
          applied: result.applied,
          record: result.record,
          error: null,
        },
      });
      if (result.applied && result.record) {
        this.options.host.broadcast({
          type: "ui_state.updated",
          namespace: request.namespace,
          key: request.key,
          record: result.record,
          updatedAt: result.record.updatedAt,
        });
      }
    } catch (error) {
      this.options.host.emit({
        type: "ui_state.upsert.response",
        payload: {
          requestId: request.requestId,
          namespace: request.namespace,
          key: request.key,
          applied: false,
          record: null,
          error: getErrorMessage(error),
        },
      });
    }
  }

  async handleClear(
    request: Extract<SessionInboundMessage, { type: "ui_state.clear.request" }>,
  ): Promise<void> {
    try {
      const result = await this.options.store.clear({
        namespace: request.namespace,
        key: request.key,
        updatedAt: request.updatedAt,
      });
      this.options.host.emit({
        type: "ui_state.clear.response",
        payload: {
          requestId: request.requestId,
          namespace: request.namespace,
          key: request.key,
          applied: result.applied,
          error: null,
        },
      });
      if (result.applied) {
        this.options.host.broadcast({
          type: "ui_state.updated",
          namespace: request.namespace,
          key: request.key,
          record: null,
          updatedAt: request.updatedAt,
        });
      }
    } catch (error) {
      this.options.host.emit({
        type: "ui_state.clear.response",
        payload: {
          requestId: request.requestId,
          namespace: request.namespace,
          key: request.key,
          applied: false,
          error: getErrorMessage(error),
        },
      });
    }
  }

  async handleList(
    request: Extract<SessionInboundMessage, { type: "ui_state.list.request" }>,
  ): Promise<void> {
    try {
      const entries = await this.options.store.list({
        namespace: request.namespace,
        keyPrefix: request.keyPrefix,
      });
      this.options.host.emit({
        type: "ui_state.list.response",
        payload: {
          requestId: request.requestId,
          namespace: request.namespace,
          entries,
          error: null,
        },
      });
    } catch (error) {
      this.options.host.emit({
        type: "ui_state.list.response",
        payload: {
          requestId: request.requestId,
          namespace: request.namespace,
          entries: [],
          error: getErrorMessage(error),
        },
      });
    }
  }
}
