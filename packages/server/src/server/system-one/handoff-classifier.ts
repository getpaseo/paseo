import type pino from "pino";
import {
  isPersonFacingOrigin,
  ORIGIN_LABEL,
  PARENT_AGENT_ID_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";
import { parseChoiceAnswer, type TypeSafeDecisionSource } from "../browser-tools/jev-client.js";

/** What a handed-back turn wants from the person; "report" wants nothing. */
export type HandoffKind = "question" | "action" | "aborted" | "report" | "unsure";

export interface WorkspaceHandoff {
  agentId: string;
  kind: HandoffKind;
  /** The agent's own sentence that says what it needs, when it said one. */
  need: string | null;
  at: string;
}

const KIND_CRITERIA = {
  question: "The agent asks the person a question and waits for the answer before it can go on.",
  action:
    "The agent needs the person to do something: approve, log in, decide, test, review or merge.",
  aborted:
    "The agent stopped in the middle of the work (a limit, an error or an interruption); the task is unfinished.",
  report:
    'The agent only reports finished work, or merely offers an optional extra ("tell me if you want …"). Nothing is required from the person.',
} as const;
const MAX_MESSAGE_CHARS = 1_600;
const MAX_SENTENCES = 12;
const MAX_NEED_CHARS = 240;

/** The closing sentences of a reply, where agents put what they need; Markdown marks removed. */
export function candidateSentences(text: string): string[] {
  const plain = text
    .slice(-MAX_MESSAGE_CHARS)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|`|~~)/g, "");
  const sentences = plain
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence.length >= 12);
  return sentences.slice(-MAX_SENTENCES).map((sentence) => sentence.slice(0, MAX_NEED_CHARS));
}

export async function classifyHandoffText(params: {
  decisionSource: TypeSafeDecisionSource;
  text: string;
  minConfidence: number;
}): Promise<{ kind: HandoffKind; need: string | null }> {
  const sentences = candidateSentences(params.text);
  const needCriteria = Object.fromEntries(
    sentences.map((sentence, index) => [`s${index}`, sentence]),
  );
  const decision = await params.decisionSource.decide({
    state: { lastAgentMessage: params.text.slice(-MAX_MESSAGE_CHARS) },
    questions: {
      kind: {
        type: "choice",
        instructions: "What does this last agent message want from the person who reads it?",
        criteria: KIND_CRITERIA,
      },
      ...(sentences.length >= 2
        ? {
            need: {
              type: "choice" as const,
              instructions:
                "Which sentence best tells the person what the agent needs from them next?",
              criteria: needCriteria,
            },
          }
        : {}),
    },
  });
  const kindAnswer = parseChoiceAnswer(decision.answers.kind, Object.keys(KIND_CRITERIA));
  const kind: HandoffKind =
    kindAnswer.confidence >= params.minConfidence ? (kindAnswer.choice as HandoffKind) : "unsure";
  if (kind === "report") return { kind, need: null };
  if (sentences.length < 2) return { kind, need: sentences[0] ?? null };
  const needAnswer = parseChoiceAnswer(decision.answers.need, Object.keys(needCriteria));
  return { kind, need: needCriteria[needAnswer.choice] ?? null };
}

export interface HandoffBackfillCandidate {
  workspaceId: string;
  agentId: string;
  cwd: string;
}

interface StoredHandoffAgent {
  id: string;
  cwd: string;
  workspaceId?: string | null;
  labels: Record<string, string>;
  lastActivityAt?: string | null;
  archivedAt?: string | null;
  internal?: boolean;
}

/** Open sessions handed back before sorting existed: the latest person-facing agent of each. */
export function handoffBackfillCandidates(params: {
  workspaces: ReadonlyArray<{ workspaceId: string; doneAt: string | null; hasHandoff: boolean }>;
  agents: readonly StoredHandoffAgent[];
  sinceMs: number;
}): HandoffBackfillCandidate[] {
  const open = new Set(
    params.workspaces
      .filter((workspace) => !workspace.doneAt && !workspace.hasHandoff)
      .map((workspace) => workspace.workspaceId),
  );
  const latest = new Map<string, StoredHandoffAgent & { activeAt: number }>();
  for (const agent of params.agents) {
    if (!agent.workspaceId || !open.has(agent.workspaceId)) continue;
    if (agent.archivedAt || agent.internal || agent.labels[PARENT_AGENT_ID_LABEL]) continue;
    if (!isPersonFacingOrigin(agent.labels[ORIGIN_LABEL])) continue;
    const activeAt = Date.parse(agent.lastActivityAt ?? "");
    if (!(activeAt >= params.sinceMs)) continue;
    const current = latest.get(agent.workspaceId);
    if (!current || activeAt > current.activeAt)
      latest.set(agent.workspaceId, { ...agent, activeAt });
  }
  return [...latest.values()].map((agent) => ({
    workspaceId: agent.workspaceId!,
    agentId: agent.id,
    cwd: agent.cwd,
  }));
}

interface HandoffAgent {
  id: string;
  cwd: string;
  workspaceId: string | null;
  labels: Record<string, string>;
}

/**
 * Sorts every handed-back turn once, so the dashboard shows what the person is needed for
 * instead of every idle session. Only sessions that talk to the person are sorted.
 */
export class HandoffClassifier {
  public constructor(
    private readonly options: {
      isEnabled: (cwd: string) => boolean;
      decisionSource: (cwd: string) => TypeSafeDecisionSource;
      minConfidence: () => number;
      resolveAgent: (agentId: string) => HandoffAgent | null;
      readLastReply: (agentId: string) => Promise<string | null>;
      save: (workspaceId: string, handoff: WorkspaceHandoff) => Promise<void>;
      logger: pino.Logger;
      now?: () => Date;
    },
  ) {}

  public observe(agent: { id: string }, event: AgentStreamEvent): void {
    // A turn the person canceled needs no reminder; they stopped it themselves.
    if (event.type !== "turn_completed" && event.type !== "turn_failed") return;
    void this.handle(agent.id, event).catch((error: unknown) => {
      this.options.logger.warn({ err: error, agentId: agent.id }, "handoff classification failed");
    });
  }

  /** Sorts sessions from before this version one by one; returns how many it sorted. */
  public async backfill(candidates: readonly HandoffBackfillCandidate[]): Promise<number> {
    let sorted = 0;
    for (const candidate of candidates) {
      if (!this.options.isEnabled(candidate.cwd)) continue;
      try {
        if (await this.classifyReply(candidate.workspaceId, candidate.agentId, candidate.cwd)) {
          sorted += 1;
        }
      } catch (error) {
        this.options.logger.warn(
          { err: error, ...candidate },
          "handoff backfill skipped a session",
        );
      }
    }
    return sorted;
  }

  private async classifyReply(workspaceId: string, agentId: string, cwd: string): Promise<boolean> {
    const text = await this.options.readLastReply(agentId);
    if (!text?.trim()) return false;
    const result = await classifyHandoffText({
      decisionSource: this.options.decisionSource(cwd),
      text,
      minConfidence: this.options.minConfidence(),
    });
    const at = (this.options.now?.() ?? new Date()).toISOString();
    await this.options.save(workspaceId, { agentId, ...result, at });
    return true;
  }

  private async handle(agentId: string, event: AgentStreamEvent): Promise<void> {
    const agent = this.options.resolveAgent(agentId);
    if (!agent?.workspaceId || !isPersonFacingOrigin(agent.labels[ORIGIN_LABEL])) return;
    const at = (this.options.now?.() ?? new Date()).toISOString();
    if (event.type === "turn_failed") {
      await this.options.save(agent.workspaceId, {
        agentId,
        kind: "aborted",
        need: event.error ? event.error.slice(0, MAX_NEED_CHARS) : null,
        at,
      });
      return;
    }
    if (!this.options.isEnabled(agent.cwd)) return;
    await this.classifyReply(agent.workspaceId, agentId, agent.cwd);
  }
}
