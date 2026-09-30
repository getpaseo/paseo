import { parseChoiceAnswer, type TypeSafeDecisionSource } from "../browser-tools/jev-client.js";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import { earliestReset, limitedProviders } from "../system-one/usage-limits.js";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import type { Logger } from "pino";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import {
  RUNTIME,
  ReportRejectedError,
  activeBinding,
  addDecision,
  applyReport,
  blockForBoss,
  boardOf,
  createTeamState,
  enterPhase,
  isWorking,
  newId,
  planItems,
  schedule,
} from "./engine.js";
import { type PackRegistry, type Role, type WorkflowPack } from "./pack.js";
import { type TeamEventDraft, TeamStore } from "./store.js";
import {
  TEAM_DECISION_LABEL,
  TEAM_ITEM_LABEL,
  TEAM_LABEL,
  TEAM_ROLE_LABEL,
  type Binding,
  type Decision,
  type PlannedItem,
  type Team,
  type TeamEvent,
  type TeamReportPayload,
  type TeamState,
  type WorkItem,
} from "./types.js";

const execFileAsync = promisify(execFile);
const DISPATCH_INTERVAL_MS = 2_000;
const HEALTH_INTERVAL_MS = 60_000;
const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const NO_PROGRESS_MS = 45 * 60_000;
const MAX_ERROR_RETRIES = 4;

type TeamAgentManager = Pick<
  AgentManager,
  "subscribe" | "getAgent" | "hasInFlightRun" | "archiveAgent"
> &
  Parameters<typeof sendPromptToAgent>[0]["agentManager"];

export interface TeamServiceOptions {
  /** The daemon's storage root; teams live under `<root>/teams`. */
  storageRoot: string;
  logger: Logger;
  agentManager: TeamAgentManager;
  agentStorage: AgentStorage;
  createAgent: BoundCreateAgentCommand;
  packs: PackRegistry;
  now?: () => Date;
  /** Tests drive dispatch and health themselves. */
  timers?: boolean;
  sendPrompt?: typeof sendPromptToAgent;
  /** Provider usage, used to wait for a known limit reset instead of guessing. */
  getUsage?: () => Promise<{ providers: ProviderUsage[] } | null>;
  /** Providers of the configured fallback chain (agent profiles), in order. */
  listFallbackProviders?: () => string[];
  /** Jev for the decisions that need interpretation; null when Jev is off for this cwd. */
  decide?: (cwd: string) => TypeSafeDecisionSource | null;
  minConfidence?: () => number;
}

export class TeamNotNeededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamNotNeededError";
  }
}

export interface TeamCallerBinding {
  teamId: string;
  binding: Binding;
}

export class TeamService {
  readonly store: TeamStore;
  private readonly logger: Logger;
  private dispatchTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private dispatchRun: Promise<void> | null = null;
  private dispatchAgain = false;
  private readonly now: () => Date;

  constructor(private readonly options: TeamServiceOptions) {
    this.store = new TeamStore(join(options.storageRoot, "teams"));
    this.logger = options.logger.child({ module: "team" });
    this.now = options.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    for (const teamId of await this.store.listIds()) {
      try {
        await this.recoverTeam(teamId);
      } catch (error) {
        this.logger.error({ err: error, teamId }, "Team recovery failed");
      }
    }
    this.unsubscribe = this.options.agentManager.subscribe(
      (event) => {
        if (event.type !== "agent_state") return;
        const teamId = event.agent.labels?.[TEAM_LABEL];
        if (!teamId || event.agent.labels?.[TEAM_ROLE_LABEL] === undefined) return;
        if (event.agent.lifecycle === "idle" || event.agent.lifecycle === "error") {
          void this.onTurnEnded(
            teamId,
            event.agent.id,
            event.agent.lifecycle === "error",
            event.agent.labels?.[TEAM_DECISION_LABEL],
          ).catch((error) =>
            this.logger.warn({ err: error, teamId }, "Team turn-end handling failed"),
          );
        }
      },
      { replayState: false },
    );
    if (this.options.timers === false) return;
    this.dispatchTimer = setInterval(() => void this.dispatchAll(), DISPATCH_INTERVAL_MS);
    this.healthTimer = setInterval(() => void this.healthAll(), HEALTH_INTERVAL_MS);
    void this.dispatchAll();
  }

  stop(): void {
    if (this.dispatchTimer) clearInterval(this.dispatchTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.unsubscribe?.();
  }

  private pack(team: Team): WorkflowPack {
    const pack = this.options.packs.get(team.packId);
    if (!pack) throw new Error(`Workflow pack ${team.packId} is not installed`);
    return pack;
  }

  /**
   * Restart path. Every outstanding wait is recorded as an active binding, so after a restart
   * each one is re-derived from the agent's persisted state instead of an in-memory closure.
   */
  private async recoverTeam(teamId: string): Promise<void> {
    const state = await this.store.get(teamId);
    if (!state || state.team.status === "done" || state.team.status === "canceled") return;
    const pack = this.options.packs.get(state.team.packId);
    if (!pack || pack.version !== state.team.packVersion) {
      const canMigrate = pack?.migrate && state.team.packVersion < pack.version;
      if (!canMigrate) {
        await this.store.commit(teamId, (draft) => {
          draft.team.status = "paused";
          draft.team.pausedReason = `pack-version-mismatch: team uses ${state.team.packId}@${state.team.packVersion}, installed ${pack ? pack.version : "none"}`;
          return {
            events: [{ type: "team.paused", actor: RUNTIME, text: draft.team.pausedReason }],
            result: null,
          };
        });
        return;
      }
      await this.store.commit(teamId, (draft) => {
        const from = draft.team.packVersion;
        for (const [id, item] of Object.entries(draft.items)) {
          draft.items[id] = { ...pack.migrate!(item.packVersion, item), packVersion: pack.version };
        }
        draft.team.packVersion = pack.version;
        return {
          events: [
            {
              type: "team.migrated",
              actor: RUNTIME,
              text: `Pack ${pack.id} migrated ${from} → ${pack.version}`,
            },
          ],
          result: null,
        };
      });
    }

    await this.store.commit(teamId, async (draft) => {
      const events: TeamEventDraft[] = [];
      for (const decision of Object.values(draft.decisions)) {
        if (decision.status === "leased") {
          decision.status = "retry";
          decision.leaseExpiresAt = undefined;
        }
      }
      for (const binding of Object.values(draft.bindings)) {
        if (binding.status !== "active" || binding.turn === "reported") continue;
        if (!binding.agentId) {
          // Seated, but the crash came before the agent id landed.
          const found = await this.findAgentForDecision(binding.decisionId);
          if (!found) continue; // the start-role decision is retried and fills this seat
          binding.agentId = found;
          binding.turn = "running";
        }
        // "starting" and "idle" seats have a pending decision that the retry covers.
        if (binding.turn !== "running") continue;
        const record = await this.options.agentStorage.get(binding.agentId);
        const item = draft.items[binding.workItemId];
        if (!record || record.archivedAt || !item) {
          binding.status = "revoked";
          binding.revokedAt = this.now().toISOString();
          if (item && isWorking(this.pack(draft.team), item)) {
            addDecision(
              draft,
              item,
              "start-role",
              { role: binding.role, revision: item.revision },
              `restart:${item.id}:${item.revision}:${binding.id}`,
            );
          }
          events.push({
            type: "recovery.reseat",
            actor: RUNTIME,
            workItemId: binding.workItemId,
            text: `${binding.role} session is gone; starting a new one`,
          });
          continue;
        }
        // The daemon restart ended the turn without a committed report: resume the same session.
        // "starting" keeps the idle state of the reloaded session from counting as a turn end.
        if (item) {
          binding.turn = "starting";
          addDecision(
            draft,
            item,
            "message-role",
            { bindingId: binding.id, resume: true },
            `resume:${binding.id}:${draft.commit}`,
          );
          events.push({
            type: "recovery.resume",
            actor: RUNTIME,
            workItemId: item.id,
            text: `Daemon restarted; resuming the ${binding.role} session for ${item.title}`,
          });
        }
      }
      return { events, result: null };
    });
  }

  // ---------------------------------------------------------------- boss API

  async startTeam(params: {
    bossAgentId: string;
    title: string;
    objective: string;
    cwd?: string;
    packId?: string;
    /** Skip Jev's "does this need a team" check. */
    force?: boolean;
  }): Promise<TeamState> {
    const boss = await this.options.agentStorage.get(params.bossAgentId);
    if (!boss) throw new Error(`Boss agent ${params.bossAgentId} not found`);
    if (boss.labels?.[TEAM_ROLE_LABEL]) throw new Error("Team members cannot start teams");
    const cwd = params.cwd ?? boss.cwd;
    if (!params.force) {
      const verdict = await this.ask(cwd, { objective: params.objective }, "team-needed", {
        question: "Does this job need a team, or can one agent do it in one session?",
        criteria: {
          single:
            "A small, contained change one agent finishes in one session without separate test and review.",
          team: "Several changes, files or steps that benefit from planning, parallel work, testing and review.",
        },
      });
      if (verdict?.choice === "single") {
        throw new TeamNotNeededError(
          `Jev thinks this is small enough to do yourself (${Math.round(verdict.confidence * 100)}% sure). Do it directly, or call team_start again with force: true.`,
        );
      }
    }
    const profile = await readProjectProfile(cwd);
    const pack = this.options.packs.get(params.packId ?? profile.workflowPack ?? "software-basic");
    if (!pack)
      throw new Error(`Workflow pack ${params.packId ?? profile.workflowPack} is not installed`);
    const defaultProfile = {
      provider: boss.provider,
      model: boss.runtimeInfo?.model ?? boss.config?.model ?? undefined,
    };
    const roleProfiles: Team["roleProfiles"] = {};
    for (const role of Object.keys(pack.roles)) {
      roleProfiles[role] = profile.roles?.[role] ?? defaultProfile;
    }
    const { state, events } = createTeamState({
      pack,
      title: params.title,
      objective: params.objective,
      cwd,
      baseBranch: await currentBranch(cwd),
      bossAgentId: params.bossAgentId,
      roleProfiles,
    });
    await this.store.create(state, events);
    await this.store.commit(state.team.id, (draft) => {
      const out: TeamEventDraft[] = [];
      schedule(draft, pack, out);
      return { events: out, result: null };
    });
    void this.dispatchAll();
    return (await this.store.get(state.team.id))!;
  }

  async status(teamId: string): Promise<{ state: TeamState; events: TeamEvent[] }> {
    const state = await this.store.get(teamId);
    if (!state) throw new Error(`Team ${teamId} not found`);
    return { state, events: await this.store.events(teamId) };
  }

  async listForBoss(bossAgentId: string): Promise<TeamState[]> {
    const out: TeamState[] = [];
    for (const id of await this.store.listIds()) {
      const state = await this.store.get(id);
      if (state && state.team.bossAgentId === bossAgentId) out.push(state);
    }
    return out;
  }

  async message(teamId: string, text: string, actorId: string): Promise<void> {
    await this.store.commit(teamId, (draft) => {
      const events: TeamEventDraft[] = [
        { type: "human.message", actor: { type: "boss", id: actorId }, text },
      ];
      // Items waiting for the boss go back into the flow with the boss's answer attached.
      for (const item of Object.values(draft.items)) {
        if (item.phase === "blocked") {
          item.reports.push({ role: "boss", phase: "blocked", outcome: "answer", summary: text });
          item.returns = 0;
          const pack = this.pack(draft.team);
          const lastWorking = item.phaseHistory.findLast(
            (h) => boardOf(pack, item).phases[h.phase]?.kind === "working",
          );
          if (lastWorking) {
            enterPhase(
              draft,
              pack,
              item,
              lastWorking.phase,
              { type: "boss", id: actorId },
              events,
              "boss answered",
            );
          }
          continue;
        }
        // A seat that stopped without a report gets the answer and another turn.
        const phase = boardOf(this.pack(draft.team), item).phases[item.phase];
        const seat = phase?.role ? activeBinding(draft, item, phase.role) : null;
        // A seat that stopped, or reported that it needs the boss, gets the answer and a turn.
        const waiting =
          seat && (seat.turn === "idle" || (seat.turn === "reported" && seat.phase === item.phase));
        if (seat && waiting) {
          seat.turn = "starting";
          seat.nudges = 0;
          addDecision(
            draft,
            item,
            "message-role",
            { bindingId: seat.id, note: text },
            `answer:${seat.id}:${draft.commit}`,
          );
        }
      }
      return { events, result: null };
    });
    void this.dispatchAll();
  }

  async setStatus(
    teamId: string,
    status: "active" | "paused" | "canceled",
    actorId: string,
  ): Promise<void> {
    await this.store.commit(teamId, (draft) => {
      draft.team.status = status;
      if (status === "active") draft.team.pausedReason = undefined;
      const events: TeamEventDraft[] = [
        { type: `team.${status}`, actor: { type: "boss", id: actorId }, text: `Team ${status}` },
      ];
      if (status === "active") schedule(draft, this.pack(draft.team), events);
      return { events, result: null };
    });
    void this.dispatchAll();
  }

  // ---------------------------------------------------------------- worker API

  async resolveCaller(agentId: string): Promise<TeamCallerBinding | null> {
    const labels =
      this.options.agentManager.getAgent(agentId)?.labels ??
      (await this.options.agentStorage.get(agentId))?.labels;
    const teamId = labels?.[TEAM_LABEL];
    if (!teamId || !labels?.[TEAM_ROLE_LABEL]) return null;
    const state = await this.store.get(teamId);
    const binding = state ? findSeat(state, agentId, labels[TEAM_DECISION_LABEL]) : undefined;
    return binding ? { teamId, binding } : null;
  }

  async report(agentId: string, payload: TeamReportPayload): Promise<string> {
    const caller = await this.resolveCaller(agentId);
    if (!caller) throw new ReportRejectedError("This session is not seated in a team");
    // PandaOS renames a worktree branch after the first prompt, so the branch is read when the
    // developer hands over, not when the seat starts.
    const team = await this.store.get(caller.teamId);
    const role = team ? this.pack(team.team).roles[caller.binding.role] : undefined;
    const branch =
      role?.workspace === "own-worktree"
        ? await currentBranch((await this.options.agentStorage.get(agentId))?.cwd ?? "")
        : undefined;
    const judged = team ? await this.judgeReport(team, caller.binding, payload) : null;
    const applied = judged?.payload ?? payload;
    try {
      const result = await this.store.commit(caller.teamId, (draft) => {
        const binding = draft.bindings[caller.binding.id]!;
        const events: TeamEventDraft[] = judged ? [judged.event] : [];
        const target = draft.items[binding.workItemId];
        if (branch && target && binding.phase === target.phase) {
          target.artifacts = target.artifacts.filter((a) => a.kind !== "branch");
          target.artifacts.push({ kind: "branch", ref: branch });
        }
        const item = applyReport(draft, this.pack(draft.team), binding, applied, events);
        return {
          events,
          result: `Report accepted. ${item.title} is now in ${item.phase}. Stop here.`,
        };
      });
      void this.dispatchAll();
      return result;
    } catch (error) {
      if (error instanceof ReportRejectedError) {
        await this.store.commit(caller.teamId, () => ({
          events: [
            {
              type: "report.rejected",
              actor: { type: "role", id: caller.binding.role },
              workItemId: caller.binding.workItemId,
              text: error.message,
            },
          ],
          result: null,
        }));
      }
      throw error;
    }
  }

  async plan(agentId: string, items: PlannedItem[]): Promise<string> {
    const caller = await this.resolveCaller(agentId);
    if (!caller) throw new ReportRejectedError("This session is not seated in a team");
    return this.store.commit(caller.teamId, (draft) => {
      const events: TeamEventDraft[] = [];
      const created = planItems(
        draft,
        this.pack(draft.team),
        draft.bindings[caller.binding.id]!,
        items,
        events,
      );
      return {
        events,
        result: `Recorded ${created.length} items. Now call team_report with outcome "planned".`,
      };
    });
  }

  // ---------------------------------------------------------------- turn ends

  async onTurnEnded(
    teamId: string,
    agentId: string,
    errored: boolean,
    decisionId?: string,
  ): Promise<void> {
    const retryAt = errored ? await this.nextProviderSlot() : null;
    await this.store.commit(teamId, (draft) => {
      const events: TeamEventDraft[] = [];
      // Checked inside the commit: an idle event from reloading a session can queue up behind the
      // commit that started its next turn.
      if (this.options.agentManager.hasInFlightRun(agentId)) return { events, result: null };
      const binding = findSeat(draft, agentId, decisionId);
      if (!binding || binding.turn !== "running") return { events, result: null };
      const item = draft.items[binding.workItemId];
      if (!item) return { events, result: null };
      binding.lastEventAt = this.now().toISOString();
      if (errored && (retryAt?.knownReset || binding.errors < MAX_ERROR_RETRIES)) {
        // Provider errors retry the same seat: at the next known limit reset when every profile is
        // exhausted, otherwise after a growing pause. Each turn runs the profile fallback again.
        if (!retryAt?.knownReset) binding.errors += 1;
        binding.turn = "idle";
        const decision = addDecision(
          draft,
          item,
          "message-role",
          { bindingId: binding.id, retry: true },
          `error-retry:${binding.id}:${item.revision}:${binding.errors}`,
        );
        const backoff = this.now().getTime() + Math.min(30, 2 ** binding.errors) * 60_000;
        decision.availableAt = retryAt?.at ?? new Date(backoff).toISOString();
        events.push({
          type: "health.provider-error",
          actor: RUNTIME,
          workItemId: item.id,
          text: retryAt?.knownReset
            ? `${binding.role} stopped: every profile is at its limit; continuing at ${decision.availableAt.slice(11, 16)} UTC when the first one resets`
            : `${binding.role} stopped with a provider error; retrying at ${decision.availableAt.slice(11, 16)} UTC`,
        });
      } else if (binding.nudges < 1) {
        binding.nudges += 1;
        binding.turn = "idle";
        addDecision(
          draft,
          item,
          "message-role",
          { bindingId: binding.id, nudge: true, errored },
          `nudge:${binding.id}:${item.revision}:${binding.nudges}`,
        );
        events.push({
          type: "health.report-missing",
          actor: RUNTIME,
          workItemId: item.id,
          text: `${binding.role} ended ${errored ? "with an error" : "its turn"} without a report; asking once more`,
        });
      } else {
        binding.turn = "idle";
        blockForBoss(
          draft,
          this.pack(draft.team),
          item,
          `${binding.role} stopped twice without a report`,
          events,
        );
      }
      return { events, result: null };
    });
    void this.dispatchAll();
  }

  /** One Jev choice question; null when Jev is off, fails, or is not sure enough. */
  private async ask(
    cwd: string,
    state: Record<string, unknown>,
    kind: string,
    question: { question: string; criteria: Record<string, string> },
  ): Promise<{ choice: string; confidence: number } | null> {
    const source = this.options.decide?.(cwd);
    if (!source) return null;
    try {
      const decision = await source.decide({
        state,
        questions: {
          [kind]: { type: "choice", instructions: question.question, criteria: question.criteria },
        },
      });
      const answer = parseChoiceAnswer(decision.answers[kind], Object.keys(question.criteria));
      const floor = this.options.minConfidence?.() ?? 0.5;
      return answer.confidence >= floor
        ? { choice: answer.choice, confidence: answer.confidence }
        : null;
    } catch (error) {
      this.logger.warn(
        { err: error, kind },
        "Jev decision failed; keeping the deterministic route",
      );
      return null;
    }
  }

  /** Jev routes a report whose outcome the pack wants judged; facts are never asked. */
  private async judgeReport(
    state: TeamState,
    binding: Binding,
    payload: TeamReportPayload,
  ): Promise<{ payload: TeamReportPayload; event: TeamEventDraft } | null> {
    const item = state.items[binding.workItemId];
    if (!item || item.phase !== binding.phase) return null;
    const judge = boardOf(this.pack(state.team), item).phases[item.phase]?.judge;
    if (!judge || payload.outcome !== judge.outcome) return null;
    const verdict = await this.ask(
      state.team.cwd,
      {
        objective: item.objective,
        acceptanceCriteria: item.acceptanceCriteria.map((c) => c.text),
        report: payload.summary,
      },
      "judge",
      judge,
    );
    if (!verdict) return null;
    const route = judge.routes[verdict.choice];
    if (!route) return null;
    const event: TeamEventDraft = {
      type: "jev.decision",
      actor: { type: "runtime", id: "jev" },
      workItemId: item.id,
      text: `Jev: ${verdict.choice} (${Math.round(verdict.confidence * 100)}%) → ${route === "@boss" ? "goes to the boss" : route}`,
      data: { question: judge.question, choice: verdict.choice, confidence: verdict.confidence },
    };
    if (route === "@boss") {
      return {
        payload: {
          ...payload,
          needs: { kind: "human", text: `${verdict.choice}: ${payload.summary}` },
        },
        event,
      };
    }
    return { payload: { ...payload, outcome: route }, event };
  }

  /**
   * When to retry after a provider error. A free profile means soon; all profiles at a limit means
   * the earliest reset the usage data knows of.
   */
  private async nextProviderSlot(): Promise<{ at: string; knownReset: boolean } | null> {
    const providers = this.options.listFallbackProviders?.() ?? [];
    if (!this.options.getUsage || providers.length === 0) return null;
    const usage = await this.options.getUsage().catch(() => null);
    const limited = limitedProviders(usage?.providers);
    if (providers.some((p) => !limited.has(p))) {
      return { at: new Date(this.now().getTime() + 2 * 60_000).toISOString(), knownReset: false };
    }
    const reset = earliestReset(providers, limited);
    if (!reset) return null;
    const cap = this.now().getTime() + 6 * 3_600_000;
    const at = Math.min(Date.parse(reset) + 60_000, cap);
    return { at: new Date(at).toISOString(), knownReset: true };
  }

  // ---------------------------------------------------------------- dispatcher

  /** Runs every due decision; a call during a run schedules one more pass and awaits it. */
  dispatchAll(): Promise<void> {
    if (this.dispatchRun) {
      this.dispatchAgain = true;
      return this.dispatchRun;
    }
    this.dispatchRun = (async () => {
      do {
        this.dispatchAgain = false;
        await this.dispatchOnce();
      } while (this.dispatchAgain);
    })().finally(() => {
      this.dispatchRun = null;
    });
    return this.dispatchRun;
  }

  private async dispatchOnce(): Promise<void> {
    try {
      for (const teamId of await this.store.listIds()) {
        const state = await this.store.get(teamId);
        if (!state || state.team.status !== "active") continue;
        const now = this.now().getTime();
        const due = Object.values(state.decisions).filter(
          (d) =>
            (d.status === "pending" || d.status === "retry") && Date.parse(d.availableAt) <= now,
        );
        for (const decision of due) {
          await this.runDecision(teamId, decision.id);
        }
      }
    } catch (error) {
      this.logger.error({ err: error }, "Team dispatch failed");
    }
  }

  private async runDecision(teamId: string, decisionId: string): Promise<void> {
    const leased = await this.store.commit(teamId, (draft) => {
      const d = draft.decisions[decisionId];
      if (!d || (d.status !== "pending" && d.status !== "retry"))
        return { events: [], result: null };
      const item = draft.items[d.workItemId];
      if (!item || item.phase !== d.phase) {
        d.status = "superseded";
        return { events: [], result: null };
      }
      d.status = "leased";
      d.attempts += 1;
      d.leaseExpiresAt = new Date(this.now().getTime() + LEASE_MS).toISOString();
      return {
        events: [],
        result: { decision: structuredClone(d), state: structuredClone(draft) },
      };
    });
    if (!leased) return;

    try {
      const outcome = await this.execute(leased.state, leased.decision);
      await this.store.commit(teamId, (draft) => {
        const d = draft.decisions[decisionId]!;
        d.status = "succeeded";
        d.leaseExpiresAt = undefined;
        const events = outcome(draft);
        return { events, result: null };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ err: error, teamId, decisionId }, "Team decision failed");
      await this.store.commit(teamId, (draft) => {
        const d = draft.decisions[decisionId]!;
        d.lastError = message;
        d.leaseExpiresAt = undefined;
        const events: TeamEventDraft[] = [];
        if (d.attempts >= MAX_ATTEMPTS) {
          d.status = "failed";
          const item = draft.items[d.workItemId];
          if (item)
            blockForBoss(
              draft,
              this.pack(draft.team),
              item,
              `${d.kind} failed: ${message}`,
              events,
            );
        } else {
          d.status = "retry";
          d.availableAt = new Date(
            this.now().getTime() + Math.min(60_000, 1000 * 2 ** d.attempts),
          ).toISOString();
        }
        return { events, result: null };
      });
    }
  }

  /** Runs the side effect, then returns the state change to commit with the decision's success. */
  private async execute(
    state: TeamState,
    decision: Decision,
  ): Promise<(draft: TeamState) => TeamEventDraft[]> {
    const pack = this.pack(state.team);
    const item = state.items[decision.workItemId]!;
    switch (decision.kind) {
      case "start-role":
        return this.startRole(state, pack, item, decision);
      case "message-role": {
        const binding = state.bindings[decision.payload.bindingId as string];
        if (!binding || binding.status !== "active") return () => [];
        const role = pack.roles[binding.role]!;
        let text = await this.workPacket(state, pack, item, role);
        if (typeof decision.payload.note === "string") {
          text = `The boss answered: ${decision.payload.note}\n\n${text}`;
        } else if (decision.payload.nudge) {
          text =
            "You ended your turn without calling `team_report`. Finish your part if needed, then call `team_report` with one of the allowed outcomes.";
        } else if (decision.payload.retry) {
          text = `Your last turn stopped with a provider error. Continue where you left off.\n\n${text}`;
        } else if (decision.payload.resume) {
          text = `The PandaOS daemon restarted while you were working. Continue where you left off.\n\n${text}`;
        }
        await (this.options.sendPrompt ?? sendPromptToAgent)({
          agentManager: this.options.agentManager,
          agentStorage: this.options.agentStorage,
          agentId: binding.agentId,
          prompt: text,
          unarchive: true,
          logger: this.logger,
        });
        return (draft) => {
          const b = draft.bindings[binding.id];
          if (b) {
            b.turn = "running";
            b.lastEventAt = this.now().toISOString();
          }
          return decision.payload.nudge || decision.payload.resume
            ? []
            : [
                {
                  type: "role.resumed",
                  actor: { type: "role", id: binding.role },
                  workItemId: item.id,
                  text: `${role.title} picks up ${item.title} again`,
                },
              ];
        };
      }
      case "notify-human": {
        const text = String(decision.payload.text ?? "");
        await (this.options.sendPrompt ?? sendPromptToAgent)({
          agentManager: this.options.agentManager,
          agentStorage: this.options.agentStorage,
          agentId: state.team.bossAgentId,
          prompt: `<system-notification from="team ${state.team.id}">\n${text}\n\nTell the user in plain language. If they answer, pass it on with team_message.\n</system-notification>`,
          activeTurnBehavior: "steer",
          unarchive: true,
          logger: this.logger,
        });
        return () => [{ type: "boss.notified", actor: RUNTIME, workItemId: item.id, text }];
      }
      case "invoke-pack-action": {
        const action = pack.actions?.[String(decision.payload.action)];
        if (!action)
          throw new Error(`Pack ${pack.id} has no action ${String(decision.payload.action)}`);
        const input = action.input.parse(decision.payload.input);
        const output = await action.run(input);
        return () => [
          {
            type: "pack.action",
            actor: RUNTIME,
            workItemId: item.id,
            text: `${pack.id}.${String(decision.payload.action)} done`,
            data: output,
          },
        ];
      }
    }
  }

  private async startRole(
    state: TeamState,
    pack: WorkflowPack,
    item: WorkItem,
    decision: Decision,
  ): Promise<(draft: TeamState) => TeamEventDraft[]> {
    const roleId = String(decision.payload.role);
    const role = pack.roles[roleId];
    if (!role) throw new Error(`Pack ${pack.id} has no role ${roleId}`);
    const profile = state.team.roleProfiles[roleId];
    if (!profile) throw new Error(`No harness bound for role ${roleId}`);
    const profileName = profile.model ? `${profile.provider}/${profile.model}` : profile.provider;

    // Seat first, agent second: a report that arrives before the agent id is recorded still
    // finds its seat through the decision label, and a crash leaves a seat recovery can finish.
    const bindingId = await this.store.commit(state.team.id, (draft) => {
      const target = draft.items[item.id];
      const existing = Object.values(draft.bindings).find(
        (b) => b.decisionId === decision.id && b.status === "active",
      );
      if (existing || !target) return { events: [], result: existing?.id ?? null };
      const now = this.now().toISOString();
      const previous = activeBinding(draft, target, roleId);
      if (previous) {
        previous.status = "revoked";
        previous.revokedAt = now;
      }
      const binding: Binding = {
        id: newId("seat"),
        workItemId: item.id,
        role: roleId,
        phase: target.phase,
        revisionAtStart: target.revision,
        decisionId: decision.id,
        agentId: "",
        profile: profileName,
        status: "active",
        turn: "starting",
        nudges: 0,
        errors: 0,
        lastEventAt: now,
        createdAt: now,
      };
      draft.bindings[binding.id] = binding;
      target.bindings[roleId] = binding.id;
      return { events: [], result: binding.id };
    });
    if (!bindingId) return () => [];

    let agentId = await this.findAgentForDecision(decision.id);
    if (!agentId) {
      const prompt = await this.workPacket(state, pack, item, role);
      const key = String(item.pack.key ?? item.id)
        .replace(/[^A-Za-z0-9-]/g, "-")
        .toLowerCase();
      const cwd =
        role.workspace === "item-worktree" ? await this.itemWorktree(state, item) : state.team.cwd;
      const created = await this.options.createAgent({
        kind: "mcp",
        provider: profileName,
        title: `${role.title} · ${item.title}`,
        cwd,
        initialPrompt: prompt,
        thinking: profile.thinking,
        mode: profile.mode,
        labels: {
          [TEAM_LABEL]: state.team.id,
          [TEAM_ROLE_LABEL]: roleId,
          [TEAM_ITEM_LABEL]: item.id,
          [TEAM_DECISION_LABEL]: decision.id,
          [PARENT_AGENT_ID_LABEL]: state.team.bossAgentId,
        },
        ...(role.workspace === "own-worktree"
          ? {
              worktree: {
                worktreeName: `team-${state.team.id.slice(-6)}-${key}`,
                branchName: `team/${state.team.id.slice(-6)}/${key}`,
                baseBranch: state.team.baseBranch ?? "main",
              },
            }
          : {}),
        unattended: true,
        promptFailure: "throw",
        background: true,
        notifyOnFinish: false,
      });
      agentId = created.snapshot.id;
    }
    const finalAgentId = agentId;
    return (draft) => {
      const binding = draft.bindings[bindingId];
      if (!binding) return [];
      binding.agentId = finalAgentId;
      // The worker may already have reported inside its first turn.
      if (binding.turn === "starting") binding.turn = "running";
      return [
        {
          type: "role.started",
          actor: { type: "role", id: roleId },
          workItemId: item.id,
          text: `${role.title} takes ${item.title} (${profileName})`,
          data: { agentId: finalAgentId, bindingId },
        },
      ];
    };
  }

  private async findAgentForDecision(decisionId: string): Promise<string | undefined> {
    const existing = (await this.options.agentStorage.list()).find(
      (r) => r.labels?.[TEAM_DECISION_LABEL] === decisionId && !r.archivedAt,
    );
    return existing?.id;
  }

  private async itemWorktree(state: TeamState, item: WorkItem): Promise<string> {
    const dev = activeBinding(state, item, "developer");
    const record = dev ? await this.options.agentStorage.get(dev.agentId) : null;
    return record?.cwd ?? state.team.cwd;
  }

  /** Everything a worker needs in one bounded prompt; previous roles are summarized, not replayed. */
  private async workPacket(
    state: TeamState,
    pack: WorkflowPack,
    item: WorkItem,
    role: Role,
  ): Promise<string> {
    const phase = boardOf(pack, item).phases[item.phase]!;
    const outcomes = Object.keys(phase.outcomes ?? {}).join(", ");
    const lines: string[] = [
      `# ${role.title}: ${item.title}`,
      "",
      role.instructions,
      "",
      `## Team goal`,
      state.team.objective,
    ];
    if (item.board === "item") {
      lines.push("", "## This work item", item.objective);
      lines.push(
        "",
        "## Acceptance criteria",
        ...item.acceptanceCriteria.map((c) => `- [${c.id}] ${c.text}`),
      );
      const deps = item.dependsOn
        .map((d) => state.items[d.id])
        .filter((d): d is WorkItem => Boolean(d))
        .map((d) => `- ${d.title}: ${d.reports.at(-1)?.summary ?? d.phase}`);
      if (deps.length) lines.push("", "## Finished dependencies", ...deps);
    }
    if (item.reports.length) {
      lines.push(
        "",
        "## History of this item",
        ...item.reports.map((r) => `- ${r.role} (${r.phase}) → ${r.outcome}: ${r.summary}`),
      );
    }
    if (item.artifacts.length) {
      lines.push(
        "",
        "## Artifacts",
        ...item.artifacts.map((a) => `- ${a.kind}: ${a.ref}${a.note ? ` (${a.note})` : ""}`),
      );
    }
    if (role.skills.length) lines.push("", `## Skills to use`, role.skills.join(", "));
    if (role.evidence && item.board === "item") {
      const file = await this.writeEvidence(state, item);
      lines.push(
        "",
        "## Review inputs",
        `- Evidence file: ${file}`,
        `- Base branch: ${state.team.baseBranch ?? "main"}`,
      );
    }
    lines.push(
      "",
      "## Rules",
      `- Allowed outcomes for team_report: ${outcomes}.`,
      role.canEdit ? "- You may change code in this workspace." : "- Do not change any files.",
      "- You cannot start other agents. Everything you hand on goes through team_report.",
    );
    return lines.join("\n");
  }

  private async writeEvidence(state: TeamState, item: WorkItem): Promise<string> {
    const dir = join(this.options.storageRoot, "teams", state.team.id, "evidence");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${item.id}.md`);
    const body = [
      `# ${item.title}`,
      "",
      "## Team goal",
      state.team.objective,
      "",
      "## Work item",
      item.objective,
      "",
      "## Acceptance criteria",
      ...item.acceptanceCriteria.map((c) => `- [${c.id}] ${c.text}`),
      "",
      "## History",
      ...item.reports.map((r) => `- ${r.role} (${r.phase}) → ${r.outcome}: ${r.summary}`),
      "",
    ].join("\n");
    await writeFile(file, body);
    return file;
  }

  // ---------------------------------------------------------------- health

  /** Deterministic findings only; anything that needs judgement goes to the boss. */
  async healthAll(): Promise<void> {
    for (const teamId of await this.store.listIds()) {
      const state = await this.store.get(teamId);
      if (!state || state.team.status !== "active") continue;
      const now = this.now().getTime();
      await this.store.commit(teamId, (draft) => {
        const events: TeamEventDraft[] = [];
        const pack = this.pack(draft.team);
        for (const d of Object.values(draft.decisions)) {
          if (d.status === "leased" && d.leaseExpiresAt && Date.parse(d.leaseExpiresAt) < now) {
            d.status = "retry";
            d.leaseExpiresAt = undefined;
            events.push({
              type: "health.decision-stuck",
              actor: RUNTIME,
              workItemId: d.workItemId,
              text: `Retrying ${d.kind}`,
            });
          }
        }
        for (const item of Object.values(draft.items)) {
          const phase = boardOf(pack, item).phases[item.phase]!;
          if (phase.kind !== "working" || !phase.role) continue;
          const binding = activeBinding(draft, item, phase.role);
          const inFlight = Object.values(draft.decisions).some(
            (d) =>
              d.workItemId === item.id &&
              ["pending", "leased", "retry", "proposed"].includes(d.status),
          );
          if (!binding && !inFlight) {
            addDecision(
              draft,
              item,
              "start-role",
              { role: phase.role, revision: item.revision },
              `seat-missing:${item.id}:${item.revision}`,
            );
            events.push({
              type: "health.seat-missing",
              actor: RUNTIME,
              workItemId: item.id,
              text: `No ${phase.role} on ${item.title}; starting one`,
            });
          }
          if (
            binding &&
            binding.turn === "running" &&
            now - Date.parse(binding.lastEventAt) > NO_PROGRESS_MS
          ) {
            const agent = this.options.agentManager.getAgent(binding.agentId);
            const lastActivity = agent?.updatedAt ? new Date(agent.updatedAt).getTime() : 0;
            if (now - lastActivity > NO_PROGRESS_MS) {
              binding.lastEventAt = new Date(now).toISOString();
              addDecision(
                draft,
                item,
                "notify-human",
                {
                  text: `${item.title}: the ${binding.role} has shown no progress for 45 minutes.`,
                },
                `no-progress:${binding.id}:${Math.floor(now / NO_PROGRESS_MS)}`,
              );
            }
          }
        }
        schedule(draft, pack, events);
        return { events, result: null };
      });
    }
    void this.dispatchAll();
  }
}

/** A seat is found by its agent, or by the decision label before the agent id is recorded. */
function findSeat(state: TeamState, agentId: string, decisionId?: string): Binding | undefined {
  return Object.values(state.bindings).find(
    (b) =>
      b.status === "active" &&
      (b.agentId === agentId || (decisionId !== undefined && b.decisionId === decisionId)),
  );
}

async function currentBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = stdout.trim();
    return branch && branch !== "HEAD" ? branch : undefined;
  } catch {
    return undefined;
  }
}

export async function readProjectProfile(cwd: string): Promise<{
  workflowPack?: string;
  roles?: Team["roleProfiles"];
}> {
  try {
    return JSON.parse(await readFile(join(cwd, ".pandaos", "project.json"), "utf8"));
  } catch {
    return {};
  }
}
