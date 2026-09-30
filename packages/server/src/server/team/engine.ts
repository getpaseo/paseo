import { randomBytes } from "node:crypto";
import type { Board, Phase, WorkflowPack } from "./pack.js";
import type { TeamEventDraft } from "./store.js";
import type {
  Actor,
  Binding,
  Decision,
  DecisionKind,
  PlannedItem,
  Team,
  TeamReportPayload,
  TeamState,
  WorkItem,
} from "./types.js";

// Pure state transitions. Every function edits a draft inside one TeamStore commit and returns
// the events of that commit; nothing here does I/O.

export const RUNTIME: Actor = { type: "runtime", id: "runtime" };

export class ReportRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportRejectedError";
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(5).toString("hex")}`;
}

export function boardOf(pack: WorkflowPack, item: WorkItem): Board {
  const board = pack.boards[item.board];
  if (!board) throw new Error(`Pack ${pack.id} has no board ${item.board}`);
  return board;
}

function phaseOf(pack: WorkflowPack, item: WorkItem, phaseId = item.phase): Phase {
  const phase = boardOf(pack, item).phases[phaseId];
  if (!phase) throw new Error(`Board ${item.board} has no phase ${phaseId}`);
  return phase;
}

export function isTerminal(pack: WorkflowPack, item: WorkItem): boolean {
  return phaseOf(pack, item).kind === "terminal";
}

export function isWorking(pack: WorkflowPack, item: WorkItem): boolean {
  return phaseOf(pack, item).kind === "working";
}

export function activeBinding(state: TeamState, item: WorkItem, role: string): Binding | null {
  const id = item.bindings[role];
  const binding = id ? state.bindings[id] : undefined;
  return binding && binding.status === "active" ? binding : null;
}

export function addDecision(
  state: TeamState,
  item: WorkItem,
  kind: DecisionKind,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Decision {
  const existing = Object.values(state.decisions).find((d) => d.idempotencyKey === idempotencyKey);
  if (existing) return existing;
  const now = new Date().toISOString();
  const decision: Decision = {
    id: newId("dec"),
    idempotencyKey,
    workItemId: item.id,
    kind,
    payload,
    phase: item.phase,
    status: "pending",
    attempts: 0,
    availableAt: now,
    createdAt: now,
  };
  state.decisions[decision.id] = decision;
  return decision;
}

export function createTeamState(params: {
  pack: WorkflowPack;
  title: string;
  objective: string;
  cwd: string;
  baseBranch?: string;
  bossAgentId: string;
  roleProfiles: Team["roleProfiles"];
}): { state: TeamState; events: TeamEventDraft[] } {
  const now = new Date().toISOString();
  const teamId = newId("team");
  const root: WorkItem = {
    id: newId("item"),
    teamId,
    packId: params.pack.id,
    packVersion: params.pack.version,
    board: "root",
    title: params.title,
    objective: params.objective,
    phase: params.pack.boards.root.initialPhase,
    phaseHistory: [
      {
        phase: params.pack.boards.root.initialPhase,
        enteredAt: now,
        by: { type: "boss", id: params.bossAgentId },
      },
    ],
    revision: 1,
    dependsOn: [],
    conflictsWith: [],
    acceptanceCriteria: [],
    artifacts: [],
    reports: [],
    returns: 0,
    bindings: {},
    pack: {},
  };
  const state: TeamState = {
    commit: 0,
    team: {
      id: teamId,
      title: params.title,
      objective: params.objective,
      cwd: params.cwd,
      baseBranch: params.baseBranch,
      bossAgentId: params.bossAgentId,
      packId: params.pack.id,
      packVersion: params.pack.version,
      rootItemId: root.id,
      status: "active",
      roleProfiles: params.roleProfiles,
      createdAt: now,
    },
    items: { [root.id]: root },
    bindings: {},
    decisions: {},
  };
  return {
    state,
    events: [
      {
        type: "team.started",
        actor: { type: "boss", id: params.bossAgentId },
        workItemId: root.id,
        text: `Team started: ${params.title}`,
      },
    ],
  };
}

/** Moves an item to a phase: history, revision, superseding stale decisions, seating the role. */
export function enterPhase(
  state: TeamState,
  pack: WorkflowPack,
  item: WorkItem,
  phaseId: string,
  actor: Actor,
  events: TeamEventDraft[],
  reason?: string,
): void {
  const target = phaseOf(pack, item, phaseId);
  const now = new Date().toISOString();
  const open = item.phaseHistory.at(-1);
  if (open && !open.exitedAt) open.exitedAt = now;
  const from = item.phase;
  item.phase = phaseId;
  item.phaseHistory.push({ phase: phaseId, enteredAt: now, by: actor });
  item.revision += 1;

  for (const decision of Object.values(state.decisions)) {
    if (
      decision.workItemId === item.id &&
      decision.phase !== phaseId &&
      (decision.status === "pending" ||
        decision.status === "retry" ||
        decision.status === "proposed")
    ) {
      decision.status = "superseded";
    }
  }

  events.push({
    type: "item.phase",
    actor,
    workItemId: item.id,
    text: `${item.title}: ${phaseOf(pack, item, from).title} → ${target.title}${reason ? ` (${reason})` : ""}`,
    data: { from, to: phaseId, revision: item.revision },
  });

  if (target.kind === "working" && target.role) {
    const binding = activeBinding(state, item, target.role);
    if (binding) {
      binding.phase = phaseId;
      binding.revisionAtStart = item.revision;
      binding.turn = "starting";
      binding.nudges = 0;
      addDecision(
        state,
        item,
        "message-role",
        { bindingId: binding.id },
        `msg:${item.id}:${item.revision}`,
      );
    } else {
      addDecision(
        state,
        item,
        "start-role",
        { role: target.role, revision: item.revision },
        `start:${item.id}:${item.revision}`,
      );
    }
  }

  if (target.kind === "terminal") {
    for (const id of Object.values(item.bindings)) {
      const binding = state.bindings[id];
      if (binding && binding.status === "active") {
        binding.status = "revoked";
        binding.revokedAt = now;
      }
    }
  }
}

function reached(item: WorkItem, phaseId: string): boolean {
  return item.phaseHistory.some((h) => h.phase === phaseId);
}

/** Deterministic scheduling: dependency gates, conflicts, exclusivity, parallel limit. */
export function schedule(state: TeamState, pack: WorkflowPack, events: TeamEventDraft[]): void {
  if (state.team.status !== "active") return;
  const items = Object.values(state.items);
  let working = items.filter((i) => i.board === "item" && isWorking(pack, i)).length;

  for (const item of items) {
    const phase = phaseOf(pack, item);
    if (phase.kind !== "resting") continue;

    if (phase.completeWithChildren) {
      const children = items.filter((i) => i.parentId === item.id);
      if (children.length > 0 && children.every((c) => isTerminal(pack, c))) {
        enterPhase(
          state,
          pack,
          item,
          phase.completeWithChildren,
          RUNTIME,
          events,
          "all items finished",
        );
        addDecision(
          state,
          item,
          "notify-human",
          { text: summarizeTeam(state, pack) },
          `done:${item.id}`,
        );
      }
      continue;
    }
    if (!phase.next) continue;
    if (item.board === "item") {
      const depsMet = item.dependsOn.every((d) => {
        const dep = state.items[d.id];
        return dep ? reached(dep, d.until) : false;
      });
      if (!depsMet) continue;
      const busy = items.filter(
        (i) => i.id !== item.id && i.board === "item" && isWorking(pack, i),
      );
      if (
        busy.some(
          (b) =>
            b.exclusive || item.conflictsWith.includes(b.id) || b.conflictsWith.includes(item.id),
        )
      )
        continue;
      if (item.exclusive && busy.length > 0) continue;
      if (working >= pack.maxParallel) continue;
      working += 1;
    }
    enterPhase(state, pack, item, phase.next, RUNTIME, events);
  }
}

export function planItems(
  state: TeamState,
  pack: WorkflowPack,
  binding: Binding,
  planned: PlannedItem[],
  events: TeamEventDraft[],
): WorkItem[] {
  const root = state.items[binding.workItemId];
  if (!root || root.board !== "root" || root.phase !== binding.phase || binding.role !== "po") {
    throw new ReportRejectedError(
      "item_plan is only available to the PO while the team is planning",
    );
  }
  if (Object.values(state.items).some((i) => i.parentId === root.id)) {
    throw new ReportRejectedError("The plan was already recorded; report your outcome instead");
  }
  const keys = new Set(planned.map((p) => p.key));
  if (keys.size !== planned.length) throw new ReportRejectedError("Item keys must be unique");
  for (const p of planned) {
    for (const ref of [...(p.dependsOn ?? []), ...(p.conflictsWith ?? [])]) {
      if (!keys.has(ref))
        throw new ReportRejectedError(`Item ${p.key} refers to unknown key ${ref}`);
    }
  }
  const now = new Date().toISOString();
  const idByKey = new Map(planned.map((p) => [p.key, newId("item")]));
  const created: WorkItem[] = [];
  for (const p of planned) {
    const item: WorkItem = {
      id: idByKey.get(p.key)!,
      teamId: state.team.id,
      packId: pack.id,
      packVersion: pack.version,
      board: "item",
      parentId: root.id,
      title: `${p.key} ${p.title}`,
      objective: p.objective,
      phase: pack.boards.item.initialPhase,
      phaseHistory: [
        { phase: pack.boards.item.initialPhase, enteredAt: now, by: { type: "role", id: "po" } },
      ],
      revision: 1,
      dependsOn: (p.dependsOn ?? []).map((k) => ({ id: idByKey.get(k)!, until: "done" })),
      conflictsWith: (p.conflictsWith ?? []).map((k) => idByKey.get(k)!),
      exclusive: p.exclusive,
      acceptanceCriteria: p.acceptanceCriteria.map((text, i) => ({
        id: `${p.key}-${i + 1}`,
        text,
      })),
      artifacts: [],
      reports: [],
      returns: 0,
      bindings: {},
      pack: { key: p.key },
    };
    state.items[item.id] = item;
    created.push(item);
  }
  // Conflicts are symmetric.
  for (const item of created) {
    for (const other of item.conflictsWith) {
      const peer = state.items[other];
      if (peer && !peer.conflictsWith.includes(item.id)) peer.conflictsWith.push(item.id);
    }
  }
  events.push({
    type: "plan.recorded",
    actor: { type: "role", id: "po" },
    workItemId: root.id,
    text: `Plan: ${created.map((c) => c.title).join(", ")}`,
    data: { items: created.map((c) => c.id) },
  });
  return created;
}

/**
 * Accepts a worker report in one commit: envelope checks, artifacts and criteria, binding state,
 * event, and the transition with its follow-up decisions.
 */
export function applyReport(
  state: TeamState,
  pack: WorkflowPack,
  binding: Binding,
  payload: TeamReportPayload,
  events: TeamEventDraft[],
): WorkItem {
  const item = state.items[binding.workItemId];
  if (!item) throw new ReportRejectedError("The work item no longer exists");
  if (binding.status !== "active") throw new ReportRejectedError("This seat was revoked");
  if (
    binding.turn === "reported" ||
    item.phase !== binding.phase ||
    item.revision !== binding.revisionAtStart
  ) {
    throw new ReportRejectedError(
      "This report is for an older state of the item; it was not applied. Stop and wait for new instructions.",
    );
  }
  const phase = phaseOf(pack, item);
  const nextPhase = phase.outcomes?.[payload.outcome];
  if (!nextPhase) {
    throw new ReportRejectedError(
      `Unknown outcome "${payload.outcome}". Allowed: ${Object.keys(phase.outcomes ?? {}).join(", ")}`,
    );
  }
  const actor: Actor = { type: "role", id: binding.role };
  item.artifacts.push(...(payload.artifacts ?? []));
  for (const c of payload.criteria ?? []) {
    const criterion = item.acceptanceCriteria.find((a) => a.id === c.id);
    if (criterion) {
      criterion.met = c.met;
      criterion.evidence = c.evidence;
    }
  }
  item.reports.push({
    role: binding.role,
    phase: item.phase,
    outcome: payload.outcome,
    summary: payload.summary,
  });
  binding.turn = "reported";
  binding.lastEventAt = new Date().toISOString();
  events.push({
    type: "report.accepted",
    actor,
    workItemId: item.id,
    text: payload.summary,
    data: { outcome: payload.outcome, bindingId: binding.id },
  });

  if (payload.needs?.kind === "human") {
    blockForBoss(state, pack, item, payload.needs.text, events);
    return item;
  }

  // A return moves to a phase the item first entered before the current one.
  const firstEntry = (phaseId: string) => item.phaseHistory.findIndex((h) => h.phase === phaseId);
  const goesBack = firstEntry(nextPhase) !== -1 && firstEntry(nextPhase) < firstEntry(item.phase);
  if (goesBack) {
    item.returns += 1;
    if (item.returns > pack.maxReturns) {
      blockForBoss(
        state,
        pack,
        item,
        `Returned ${item.returns} times; last: ${payload.summary}`,
        events,
      );
      return item;
    }
  }
  enterPhase(
    state,
    pack,
    item,
    nextPhase,
    actor,
    events,
    goesBack ? `returned by ${binding.role}` : undefined,
  );
  schedule(state, pack, events);
  return item;
}

export function blockForBoss(
  state: TeamState,
  pack: WorkflowPack,
  item: WorkItem,
  why: string,
  events: TeamEventDraft[],
): void {
  if (boardOf(pack, item).phases.blocked) {
    enterPhase(state, pack, item, "blocked", RUNTIME, events, why);
  }
  addDecision(
    state,
    item,
    "notify-human",
    { text: `${item.title} needs you: ${why}` },
    `block:${item.id}:${item.revision}`,
  );
}

export function summarizeTeam(state: TeamState, pack: WorkflowPack): string {
  const items = Object.values(state.items).filter((i) => i.board === "item");
  const lines = items.map((i) => {
    const last = i.reports.at(-1);
    const refs = i.artifacts.map((a) => `${a.kind} ${a.ref}`).join(", ");
    return `- ${i.title}: ${phaseOf(pack, i).title}${last ? ` — ${last.summary}` : ""}${refs ? ` (${refs})` : ""}`;
  });
  return `Team "${state.team.title}" finished.\n${lines.join("\n")}`;
}
