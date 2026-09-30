import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
  /**
   * Working phases only: when a worker reports `outcome`, Jev classifies the report and the
   * answer picks the route: another outcome of this phase, or "@boss" to hand it to the boss.
   * Without Jev, or below the confidence floor, the reported outcome stands.
   */
  judge?: Judge;
}

export interface Judge {
  outcome: string;
  question: string;
  criteria: Record<string, string>;
  routes: Record<string, string>;
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
  /** The runtime writes the item's goal and criteria to a file and hands its path to the role. */
  evidence?: boolean;
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
  /** Claims a repository for this pack when its project profile names none. */
  matches?: (cwd: string) => boolean | Promise<boolean>;
}

function phaseProblems(
  id: string,
  phase: Phase,
  phaseIds: Set<string>,
  roles: Record<string, Role>,
): string[] {
  const problems: string[] = [];
  if (phase.kind === "working") {
    if (!phase.role || !roles[phase.role]) problems.push(`working phase ${id} needs a known role`);
    if (!phase.outcomes || Object.keys(phase.outcomes).length === 0)
      problems.push(`working phase ${id} needs outcomes`);
  } else if (phase.role || phase.outcomes) {
    problems.push(`${phase.kind} phase ${id} cannot have a role or outcomes`);
  }
  if (phase.kind !== "resting" && (phase.next || phase.completeWithChildren))
    problems.push(`only resting phases advance automatically (${id})`);
  const targets = [...Object.values(phase.outcomes ?? {}), phase.next, phase.completeWithChildren];
  for (const target of targets) {
    if (target && !phaseIds.has(target))
      problems.push(`phase ${id} points to unknown phase ${target}`);
  }
  if (phase.judge) problems.push(...judgeProblems(id, phase, phase.judge));
  return problems;
}

function judgeProblems(id: string, phase: Phase, judge: Judge): string[] {
  const problems: string[] = [];
  if (!phase.outcomes?.[judge.outcome]) problems.push(`phase ${id} judges an unknown outcome`);
  for (const route of Object.values(judge.routes)) {
    if (route !== "@boss" && !phase.outcomes?.[route])
      problems.push(`phase ${id} routes to unknown outcome ${route}`);
  }
  return problems;
}

export function validateBoard(name: string, board: Board, roles: Record<string, Role>): void {
  const phaseIds = new Set(Object.keys(board.phases));
  const problems: string[] = [];
  if (!phaseIds.has(board.initialPhase))
    problems.push(`unknown initial phase ${board.initialPhase}`);
  if (board.phases[board.initialPhase]?.kind !== "resting")
    problems.push("initial phase must be resting");
  for (const [id, phase] of Object.entries(board.phases)) {
    problems.push(...phaseProblems(id, phase, phaseIds, roles));
  }
  if (problems.length > 0) throw new Error(`Board ${name}: ${problems.join("; ")}`);
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
        "session. Every item is tested and reviewed by the team automatically, so never create items " +
        "for testing, review or verification. Do not write code. Then report outcome `planned`. " +
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
      skills: ["codex-review"],
      evidence: true,
      instructions:
        "You are the reviewer for this work item. Use the `codex-review` skill: run its review script with " +
        "the evidence file and base branch given below (`--evidence <file> --base <branch> --sandbox read-only`), " +
        "wait for it, and read its verdict and findings. Do not change code. Report `approve` when it finds " +
        "nothing blocking, otherwise `changes` with each blocking finding, its file and why. " +
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
          judge: {
            outcome: "fail",
            question: "What kind of failure does this test report describe?",
            criteria: {
              code: "The implementation is wrong or incomplete.",
              test: "The tests or checks themselves are wrong or flaky.",
              environment:
                "A missing tool, service, credential or setup blocks the test, not the code.",
              requirement:
                "The acceptance criteria are unclear, contradictory or impossible as written.",
            },
            routes: { code: "fail", test: "fail", environment: "@boss", requirement: "@boss" },
          },
        },
        review: {
          title: "Review",
          kind: "working",
          role: "reviewer",
          outcomes: { approve: "done", changes: "implement" },
          judge: {
            outcome: "changes",
            question: "How severe is the most serious finding in this review?",
            criteria: {
              blocker: "A finding breaks behaviour, security, data or the acceptance criteria.",
              major: "A finding must be fixed before merge but does no harm yet.",
              minor: "Only style, naming, wording or optional improvements.",
            },
            routes: { blocker: "changes", major: "changes", minor: "approve" },
          },
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

  /** Loads every `<dir>/<pack>/pack.mjs` whose default export is a workflow pack. */
  async loadFrom(
    dir: string,
  ): Promise<{ loaded: string[]; failed: Array<{ path: string; error: string }> }> {
    const loaded: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return { loaded, failed };
    }
    for (const entry of entries) {
      const path = join(dir, entry, "pack.mjs");
      try {
        const module = (await import(pathToFileURL(path).href)) as { default?: WorkflowPack };
        if (!module.default) throw new Error("pack.mjs has no default export");
        this.register(module.default);
        loaded.push(module.default.id);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") continue;
        failed.push({ path, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { loaded, failed };
  }

  /** The profile's pack, else the first pack that claims the repository, else the default. */
  async resolveFor(cwd: string, preferred?: string): Promise<WorkflowPack | undefined> {
    if (preferred) return this.packs.get(preferred);
    for (const pack of this.packs.values()) {
      if (pack.matches && (await pack.matches(cwd))) return pack;
    }
    return this.packs.get(softwareBasicPack.id);
  }
}
