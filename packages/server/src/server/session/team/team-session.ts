import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { TeamService } from "../../team/service.js";
import type { TeamEvent, TeamState } from "../../team/types.js";

type TeamSummary = Extract<
  SessionOutboundMessage,
  { type: "team.list.response" }
>["payload"]["teams"][number];

type TeamRequest = Extract<
  SessionInboundMessage,
  { type: "team.list.request" | "team.events.request" | "team.message.request" }
>;

export interface TeamSessionOptions {
  host: { emit(msg: SessionOutboundMessage): void };
  teamService: TeamService | undefined;
  logger: pino.Logger;
}

/** The app's view of the team runtime: list teams, read the event log, post into the chat. */
export class TeamSession {
  constructor(private readonly options: TeamSessionOptions) {}

  async handleTeamListRequest(
    request: Extract<SessionInboundMessage, { type: "team.list.request" }>,
  ): Promise<void> {
    try {
      const store = this.service().store;
      const teams: TeamSummary[] = [];
      for (const id of await store.listIds()) {
        const state = await store.get(id);
        if (!state) continue;
        const events = await store.events(id);
        teams.push(toTeamSummary(state, events));
      }
      teams.sort((a, b) =>
        (b.lastEventAt ?? b.createdAt).localeCompare(a.lastEventAt ?? a.createdAt),
      );
      this.options.host.emit({
        type: "team.list.response",
        payload: { requestId: request.requestId, teams },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleTeamEventsRequest(
    request: Extract<SessionInboundMessage, { type: "team.events.request" }>,
  ): Promise<void> {
    try {
      const { state, events } = await this.service().status(request.teamId);
      const after = request.afterCommit ?? -1;
      this.options.host.emit({
        type: "team.events.response",
        payload: {
          requestId: request.requestId,
          teamId: request.teamId,
          team: toTeamSummary(state, events),
          commit: state.commit,
          events: events.filter((event) => event.commit > after),
          bindings: Object.values(state.bindings).map((binding) => ({
            id: binding.id,
            workItemId: binding.workItemId,
            role: binding.role,
            agentId: binding.agentId,
            turn: binding.turn,
            status: binding.status,
          })),
        },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleTeamMessageRequest(
    request: Extract<SessionInboundMessage, { type: "team.message.request" }>,
  ): Promise<void> {
    const text = request.text.trim();
    try {
      if (!text) throw new Error("Message is empty");
      await this.service().message(request.teamId, text, { type: "human", id: "user" });
      this.options.host.emit({
        type: "team.message.response",
        payload: { requestId: request.requestId, ok: true, error: null },
      });
    } catch (error) {
      this.options.host.emit({
        type: "team.message.response",
        payload: {
          requestId: request.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private service(): TeamService {
    if (!this.options.teamService) throw new Error("Teams are unavailable on this daemon");
    return this.options.teamService;
  }

  private emitError(request: TeamRequest, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.options.logger.error({ err: error, requestType: request.type }, "Team request failed");
    this.options.host.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        error: message,
        code: "team_request_failed",
      },
    });
  }
}

function toTeamSummary(state: TeamState, events: TeamEvent[]): TeamSummary {
  return {
    id: state.team.id,
    title: state.team.title,
    status: state.team.status,
    bossAgentId: state.team.bossAgentId,
    createdAt: state.team.createdAt,
    items: Object.values(state.items).map((item) => ({
      id: item.id,
      title: item.title,
      phase: item.phase,
      board: item.board,
    })),
    lastEventAt: events.at(-1)?.at ?? null,
  };
}
