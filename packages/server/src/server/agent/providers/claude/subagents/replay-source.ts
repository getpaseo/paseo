import { z } from "zod";

import type { AgentTimelineItem } from "../../../agent-sdk-types.js";
import { normalizeProviderReplayTimestamp } from "../../../provider-history-timestamps.js";
import type { SubagentObservation } from "./observation.js";

/**
 * Rebuilds subagent observations from a persisted session, producing the same vocabulary the
 * live task-protocol source produces. Identical observations in means identical descriptor
 * state out, so a fact is derived once for both paths rather than once per path.
 *
 * Claude Code writes each subagent as `<session>/subagents/agent-<agentId>.jsonl` beside an
 * `agent-<agentId>.meta.json`. The meta file carries the Task `tool_use_id`, which is the same
 * canonical id the live stream uses — it is the bridge that lets the two paths agree.
 */

const ClaudeSubagentMetaSchema = z.object({
  agentType: z.string().optional().catch(undefined),
  description: z.string().optional().catch(undefined),
  toolUseId: z.string().optional().catch(undefined),
  spawnDepth: z.number().optional().catch(undefined),
});

export type ClaudeSubagentMeta = z.infer<typeof ClaudeSubagentMetaSchema>;

/**
 * Parse a sidecar meta file. This is undocumented Claude Code internals, so every field is
 * optional and a malformed file is indistinguishable from an absent one: callers fall back to
 * the parent-transcript derivation rather than losing the subagent.
 */
export function parseClaudeSubagentMeta(contents: string): ClaudeSubagentMeta | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  const result = ClaudeSubagentMetaSchema.safeParse(parsed);
  if (!result.success) return null;
  const meta = result.data;
  const hasAnyField =
    meta.agentType !== undefined ||
    meta.description !== undefined ||
    meta.toolUseId !== undefined ||
    meta.spawnDepth !== undefined;
  return hasAnyField ? meta : null;
}

export interface ClaudeReplayEntry {
  type?: unknown;
  agentId?: unknown;
  timestamp?: unknown;
  message?: { content?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ClaudeReplaySubagentInput {
  agentId: string;
  meta: ClaudeSubagentMeta | null;
  entries: ClaudeReplayEntry[];
}

export interface ClaudeReplayParentFacts {
  /** Task `tool_use` id -> identity declared in the parent's tool input. */
  toolCalls: ReadonlyMap<string, { title?: string; description?: string }>;
  /** agentId -> tool call, recovered by scraping tool-result text. Legacy fallback only. */
  linksByAgentId: ReadonlyMap<string, { toolCallId: string; failed: boolean }>;
  /** Task `tool_use` id -> outcome. Usable once meta.json supplies the link directly. */
  outcomesByToolCallId: ReadonlyMap<string, { failed: boolean }>;
}

interface ResolvedLink {
  id: string;
  toolCallId: string | null;
  failed: boolean | null;
}

/**
 * Resolve the canonical subagent id.
 *
 * `meta.toolUseId` is authoritative: it is the same id the live stream keys on. The legacy path
 * scrapes `agentId:` out of stringified tool-result content, which both misses the link when the
 * parent's tool_result is absent and matches unrelated text — on a real five-subagent session it
 * produced eight ids, inventing `z`, `string`, and `update`. It stays only as a fallback for
 * sessions recorded before the meta file existed.
 */
function resolveLink(
  subagent: ClaudeReplaySubagentInput,
  parent: ClaudeReplayParentFacts,
): ResolvedLink {
  const metaToolUseId = subagent.meta?.toolUseId?.trim();
  if (metaToolUseId) {
    const outcome = parent.outcomesByToolCallId.get(metaToolUseId);
    return {
      id: metaToolUseId,
      toolCallId: metaToolUseId,
      failed: outcome ? outcome.failed : null,
    };
  }

  const scraped = parent.linksByAgentId.get(subagent.agentId);
  if (scraped) {
    return { id: scraped.toolCallId, toolCallId: scraped.toolCallId, failed: scraped.failed };
  }

  // No link at all: keep the subagent visible under its own agent id rather than dropping it.
  return { id: subagent.agentId, toolCallId: null, failed: null };
}

function observeSubagent(
  subagent: ClaudeReplaySubagentInput,
  parent: ClaudeReplayParentFacts,
  convertEntry: (entry: ClaudeReplayEntry) => AgentTimelineItem[],
): SubagentObservation[] {
  const link = resolveLink(subagent, parent);
  const toolCall = link.toolCallId ? parent.toolCalls.get(link.toolCallId) : undefined;

  // The parent's tool input is the same source the live path reads, so it wins; meta.json fills
  // the gap when the parent's Task call is missing from the transcript.
  const title = toolCall?.title ?? subagent.meta?.agentType;
  const description = toolCall?.description ?? subagent.meta?.description;

  const observations: SubagentObservation[] = [];
  const firstTimestamp = normalizeProviderReplayTimestamp(subagent.entries[0]?.timestamp);
  observations.push({
    kind: "declared",
    id: link.id,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(link.toolCallId ? { toolCallId: link.toolCallId } : {}),
    ...(firstTimestamp ? { timestamp: firstTimestamp } : {}),
  });

  for (const entry of subagent.entries) {
    const timestamp = normalizeProviderReplayTimestamp(entry.timestamp);
    for (const item of convertEntry(entry)) {
      observations.push({
        kind: "timeline",
        id: link.id,
        item,
        ...(timestamp ? { timestamp } : {}),
      });
    }
  }

  // A transcript with no recorded outcome is a subagent that never finished — leave it running
  // rather than inventing a completion.
  if (link.failed !== null) {
    const lastTimestamp = normalizeProviderReplayTimestamp(subagent.entries.at(-1)?.timestamp);
    observations.push({
      kind: "status",
      id: link.id,
      status: link.failed ? "failed" : "completed",
      ...(lastTimestamp ? { timestamp: lastTimestamp } : {}),
    });
  }

  return observations;
}

/**
 * Whether this transcript belongs to a child of the session being replayed.
 *
 * Claude Code writes every descendant into the same `subagents/` directory, not just the session's
 * own children, and `spawnDepth` is what separates them: 1 is a direct child, 2+ was spawned by
 * another subagent. A grandchild's `toolUseId` names a Task call made inside its parent's session,
 * so nothing in this transcript can resolve it — surveyed across recorded sessions, every depth-1
 * id matched a Task tool_use block in the parent transcript and no deeper id did. Replaying them
 * anyway adds rows the live stream never showed, each with no Task card and no recoverable
 * outcome, which leaves them running forever. One session recorded 10 subagents live and would
 * replay 22.
 *
 * Absent depth means a session recorded before the field existed: keep the subagent rather than
 * lose it, matching how every other missing field here is treated.
 */
function isDirectChild(subagent: ClaudeReplaySubagentInput): boolean {
  const depth = subagent.meta?.spawnDepth;
  return depth === undefined || depth <= 1;
}

export function observeReplaySubagents(input: {
  subagents: readonly ClaudeReplaySubagentInput[];
  parent: ClaudeReplayParentFacts;
  convertEntry: (entry: ClaudeReplayEntry) => AgentTimelineItem[];
}): SubagentObservation[] {
  const observations: SubagentObservation[] = [];
  for (const subagent of input.subagents) {
    if (!isDirectChild(subagent)) continue;
    observations.push(...observeSubagent(subagent, input.parent, input.convertEntry));
  }
  return observations;
}
