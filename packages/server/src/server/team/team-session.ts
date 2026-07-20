import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type pino from "pino";
import { TeamStore } from "./team-store.js";

export type TeamSessionRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "team.list.request"
      | "team.create.request"
      | "team.update.request"
      | "team.delete.request"
      | "team.get.request"
      | "team.send_run.request"
      | "team.run_state.request";
  }
>;

export interface TeamSessionHost {
  emit(message: SessionOutboundMessage): void;
}

export interface TeamSessionOptions {
  host: TeamSessionHost;
  store: TeamStore;
  logger: pino.Logger;
}

export class TeamSession {
  private readonly host: TeamSessionHost;
  private readonly store: TeamStore;
  private readonly logger: pino.Logger;

  constructor(options: TeamSessionOptions) {
    this.host = options.host;
    this.store = options.store;
    this.logger = options.logger.child({ module: "team-session" });
  }

  async handleRequest(message: TeamSessionRequest): Promise<void> {
    try {
      switch (message.type) {
        case "team.list.request":
          this.host.emit({
            type: "team.list.response",
            payload: {
              requestId: message.requestId,
              teams: this.store.list(),
              error: null,
            },
          });
          return;
        case "team.get.request": {
          const team = this.store.get(message.id);
          this.host.emit({
            type: "team.get.response",
            payload: {
              requestId: message.requestId,
              team,
              error: team ? null : "Team not found",
            },
          });
          return;
        }
        case "team.create.request": {
          const team = this.store.create(message.team);
          this.emitChanged();
          this.host.emit({
            type: "team.create.response",
            payload: { requestId: message.requestId, team, error: null },
          });
          return;
        }
        case "team.update.request": {
          const team = this.store.update(message.team);
          if (!team) {
            this.host.emit({
              type: "team.update.response",
              payload: { requestId: message.requestId, team: null, error: "Team not found" },
            });
            return;
          }
          this.emitChanged();
          this.host.emit({
            type: "team.update.response",
            payload: { requestId: message.requestId, team, error: null },
          });
          return;
        }
        case "team.delete.request": {
          const ok = this.store.delete(message.id);
          if (ok) this.emitChanged();
          this.host.emit({
            type: "team.delete.response",
            payload: {
              requestId: message.requestId,
              id: message.id,
              ok,
              error: ok ? null : "Team not found",
            },
          });
          return;
        }
        case "team.send_run.request":
          // TODO: implement team run orchestration with agent manager
          this.host.emit({
            type: "team.send_run.response",
            payload: {
              requestId: message.requestId,
              runId: null,
              slotWork: [],
              error: "Team run orchestration not yet implemented",
            },
          });
          return;
        case "team.run_state.request":
          // TODO: implement team run state with agent manager
          this.host.emit({
            type: "team.run_state.response",
            payload: {
              requestId: message.requestId,
              activeRunId: null,
              slotWork: [],
              error: "Team run orchestration not yet implemented",
            },
          });
          return;
      }
    } catch (error) {
      this.logger.warn({ err: error, requestType: message.type }, "Team RPC failed");
      this.emitErrorResponse(message, error instanceof Error ? error.message : String(error));
    }
  }

  private emitChanged(): void {
    this.host.emit({
      type: "team.changed",
      payload: { teams: this.store.list() },
    });
  }

  private emitErrorResponse(message: TeamSessionRequest, error: string): void {
    switch (message.type) {
      case "team.list.request":
        this.host.emit({
          type: "team.list.response",
          payload: { requestId: message.requestId, teams: this.store.list(), error },
        });
        return;
      case "team.get.request":
        this.host.emit({
          type: "team.get.response",
          payload: { requestId: message.requestId, team: null, error },
        });
        return;
      case "team.create.request":
        this.host.emit({
          type: "team.create.response",
          payload: { requestId: message.requestId, team: null, error },
        });
        return;
      case "team.update.request":
        this.host.emit({
          type: "team.update.response",
          payload: { requestId: message.requestId, team: null, error },
        });
        return;
      case "team.delete.request":
        this.host.emit({
          type: "team.delete.response",
          payload: { requestId: message.requestId, id: message.id, ok: false, error },
        });
        return;
      case "team.send_run.request":
        this.host.emit({
          type: "team.send_run.response",
          payload: { requestId: message.requestId, runId: null, slotWork: [], error },
        });
        return;
      case "team.run_state.request":
        this.host.emit({
          type: "team.run_state.response",
          payload: { requestId: message.requestId, activeRunId: null, slotWork: [], error },
        });
        return;
    }
  }
}
