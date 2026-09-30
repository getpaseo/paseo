import type { z } from "zod";
import type { WorkItem } from "./types.js";

// Board model adapted from mastra-ai/mastra mastracode/factory boards/define-board.ts,
// Apache-2.0. Modified for PandaOS: resting phases may auto-advance and complete with children.

export type PhaseKind = "resting" | "working" | "terminal";

export interface Phase {
  title: string;
  kind: PhaseKind;
  /** Working phases only: the role that works the item here. */
  role?: string;
  /** Working phases only: reported outcome -> next phase. */
  outcomes?: Record<string, string>;
  /** Resting phases only: the runtime moves the item here once dependencies and conflicts allow. */
  next?: string;
  /** Resting phases only: the item moves to this phase once all child items are terminal. */
  completeWithChildren?: string;
}

export interface Board {
  initialPhase: string;
  phases: Record<string, Phase>;
}

export interface Role {
  id: string;
  title: string;
  instructions: string;
  skills: string[];
  /** false: the runtime starts the session read-only where the provider supports it. */
  canEdit: boolean;
  /** team: the team's cwd. own-worktree: a new worktree for the item. item-worktree: the item's worktree. */
  workspace: "team" | "own-worktree" | "item-worktree";
  /** Extra team tools this role gets besides team_report. */
  tools: Array<"item_plan">;
}

export interface PackAction {
  input: z.ZodType;
  run: (input: unknown) => Promise<Record<string, unknown>>;
}

export interface WorkflowPack {
  id: string;
  version: number;
  title: string;
  boards: { root: Board; item: Board } & Record<string, Board>;
  roles: Record<string, Role>;
  /** Returned items above this many returns go to the boss instead of another loop. */
  maxReturns: number;
  maxParallel: number;
  actions?: Record<string, PackAction>;
  migrate?: (fromVersion: number, item: WorkItem) => WorkItem;
}

export function validateBoard(name: string, board: Board, roles: Record<string, Role>): void {
  const phaseIds = new Set(Object.keys(board.phases));
  const fail = (msg: string) => {
    throw new Error(`Board ${name}: ${msg}`);
  };
  if (!phaseIds.has(board.initialPhase)) fail(`unknown initial phase ${board.initialPhase}`);
  if (board.phases[board.initialPhase]?.kind !== "resting") fail("initial phase must be resting");
  for (const [id, phase] of Object.entries(board.phases)) {
    if (phase.kind === "working") {
      if (!phase.role || !roles[phase.role]) fail(`working phase ${id} needs a known role`);
      if (!phase.outcomes || Object.keys(phase.outcomes).length === 0)
        fail(`working phase ${id} needs outcomes`);
    } else if (phase.role || phase.outcomes) {
      fail(`${phase.kind} phase ${id} cannot have a role or outcomes`);
    }
    if (phase.kind !== "resting" && (phase.next || phase.completeWithChildren))
      fail(`only resting phases advance automatically (${id})`);
    for (const target of [
      ...Object.values(phase.outcomes ?? {}),
      phase.next,
      phase.completeWithChildren,
    ]) {
      if (target && !phaseIds.has(target)) fail(`phase ${id} points to unknown phase ${target}`);
    }
  }
}

export function validatePack(pack: WorkflowPack): WorkflowPack {
  for (const [name, board] of Object.entries(pack.boards)) validateBoard(name, board, pack.roles);
  return pack;
}

const REPORT_RULE =
  "When your part is finished, call the `team_report` tool exactly once with one of the allowed outcomes. " +
  "Do not start other agents; if more work is needed, say so in `needs`.";

export const softwareBasicPack: WorkflowPack = validatePack({
  id: "software-basic",
  version: 1,
  title: "Software (basic)",
  maxReturns: 3,
  maxParallel: 3,
  roles: {
    po: {
      id: "po",
      title: "PO",
      canEdit: false,
      workspace: "team",
      tools: ["item_plan"],
      skills: [],
      instructions:
        "You are the PO of this team. Read the repository and the objective, then plan the work in one pass. " +
        "Call `item_plan` once with every work item: a short key, title, objective, acceptance criteria that a " +
        "tester can check, dependencies (keys of items that must be done first) and conflicts (keys of items " +
        "that touch the same files and must not run at the same time). Keep items small enough for one developer " +
        "session. Do not write code. Then report outcome `planned`. " +
        REPORT_RULE,
    },
    developer: {
      id: "developer",
      title: "Developer",
      canEdit: true,
      workspace: "own-worktree",
      tools: [],
      skills: [],
      instructions:
        "You are the developer for this work item, working in your own git worktree. Implement it, run the " +
        "relevant fast checks, and commit your change on the current branch. If the item came back from test or " +
        "review, fix exactly what the report says. Report outcome `done` with the branch and commit as artifacts. " +
        REPORT_RULE,
    },
    tester: {
      id: "tester",
      title: "Tester",
      canEdit: false,
      workspace: "item-worktree",
      tools: [],
      skills: [],
      instructions:
        "You are the tester for this work item. Check every acceptance criterion against the developer's commit " +
        "by running the relevant tests or commands. Do not change code. Report `pass` when every criterion is met " +
        "with evidence, otherwise `fail` with what failed and how to reproduce it. " +
        REPORT_RULE,
    },
    reviewer: {
      id: "reviewer",
      title: "Reviewer",
      canEdit: false,
      workspace: "item-worktree",
      tools: [],
      skills: [],
      instructions:
        "You are the reviewer for this work item. Review the developer's commit against the objective for " +
        "correctness, regressions and needless complexity. Do not change code. Report `approve` when nothing " +
        "blocks it, otherwise `changes` with each blocking finding and where it is. " +
        REPORT_RULE,
    },
  },
  boards: {
    root: {
      initialPhase: "intake",
      phases: {
        intake: { title: "Intake", kind: "resting", next: "plan" },
        plan: { title: "Plan", kind: "working", role: "po", outcomes: { planned: "execute" } },
        execute: { title: "Execute", kind: "resting", completeWithChildren: "done" },
        done: { title: "Done", kind: "terminal" },
        canceled: { title: "Canceled", kind: "terminal" },
      },
    },
    item: {
      initialPhase: "ready",
      phases: {
        ready: { title: "Ready", kind: "resting", next: "implement" },
        implement: {
          title: "Implement",
          kind: "working",
          role: "developer",
          outcomes: { done: "test" },
        },
        test: {
          title: "Test",
          kind: "working",
          role: "tester",
          outcomes: { pass: "review", fail: "implement" },
        },
        review: {
          title: "Review",
          kind: "working",
          role: "reviewer",
          outcomes: { approve: "done", changes: "implement" },
        },
        blocked: { title: "Needs the boss", kind: "resting" },
        done: { title: "Done", kind: "terminal" },
        canceled: { title: "Canceled", kind: "terminal" },
      },
    },
  },
});

export class PackRegistry {
  private readonly packs = new Map<string, WorkflowPack>();

  constructor(packs: WorkflowPack[] = [softwareBasicPack]) {
    for (const pack of packs) this.register(pack);
  }

  register(pack: WorkflowPack): void {
    this.packs.set(pack.id, validatePack(pack));
  }

  get(id: string): WorkflowPack | undefined {
    return this.packs.get(id);
  }
}
