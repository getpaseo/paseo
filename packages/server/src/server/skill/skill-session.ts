import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type pino from "pino";
import { SkillStore } from "./skill-store.js";

export type SkillSessionRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "skill.list.request"
      | "skill.create.request"
      | "skill.update.request"
      | "skill.delete.request";
  }
>;

export interface SkillSessionHost {
  emit(message: SessionOutboundMessage): void;
}

export interface SkillSessionOptions {
  host: SkillSessionHost;
  store: SkillStore;
  logger: pino.Logger;
}

export class SkillSession {
  private readonly host: SkillSessionHost;
  private readonly store: SkillStore;
  private readonly logger: pino.Logger;

  constructor(options: SkillSessionOptions) {
    this.host = options.host;
    this.store = options.store;
    this.logger = options.logger.child({ module: "skill-session" });
  }

  async handleRequest(message: SkillSessionRequest): Promise<void> {
    try {
      switch (message.type) {
        case "skill.list.request":
          this.host.emit({
            type: "skill.list.response",
            payload: {
              requestId: message.requestId,
              skills: this.store.list(),
              error: null,
            },
          });
          return;
        case "skill.create.request": {
          const skill = this.store.create(message.skill);
          this.emitChanged();
          this.host.emit({
            type: "skill.create.response",
            payload: { requestId: message.requestId, skill, error: null },
          });
          return;
        }
        case "skill.update.request": {
          const skill = this.store.update(message.skill);
          if (!skill) {
            this.host.emit({
              type: "skill.update.response",
              payload: { requestId: message.requestId, skill: null, error: "Skill not found" },
            });
            return;
          }
          this.emitChanged();
          this.host.emit({
            type: "skill.update.response",
            payload: { requestId: message.requestId, skill, error: null },
          });
          return;
        }
        case "skill.delete.request": {
          const ok = this.store.delete(message.id);
          if (ok) this.emitChanged();
          this.host.emit({
            type: "skill.delete.response",
            payload: {
              requestId: message.requestId,
              id: message.id,
              ok,
              error: ok ? null : "Skill not found",
            },
          });
          return;
        }
      }
    } catch (error) {
      this.logger.warn({ err: error, requestType: message.type }, "Skill RPC failed");
      this.emitErrorResponse(message, error instanceof Error ? error.message : String(error));
    }
  }

  private emitChanged(): void {
    this.host.emit({
      type: "skill.changed",
      payload: { skills: this.store.list() },
    });
  }

  private emitErrorResponse(message: SkillSessionRequest, error: string): void {
    switch (message.type) {
      case "skill.list.request":
        this.host.emit({
          type: "skill.list.response",
          payload: { requestId: message.requestId, skills: this.store.list(), error },
        });
        return;
      case "skill.create.request":
        this.host.emit({
          type: "skill.create.response",
          payload: { requestId: message.requestId, skill: null, error },
        });
        return;
      case "skill.update.request":
        this.host.emit({
          type: "skill.update.response",
          payload: { requestId: message.requestId, skill: null, error },
        });
        return;
      case "skill.delete.request":
        this.host.emit({
          type: "skill.delete.response",
          payload: { requestId: message.requestId, id: message.id, ok: false, error },
        });
        return;
    }
  }
}
