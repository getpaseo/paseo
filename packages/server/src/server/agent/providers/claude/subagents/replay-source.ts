import { z } from "zod";

import type { AgentTimelineItem } from "../../../agent-sdk-types.js";
import { normalizeProviderReplayTimestamp } from "../../../provider-history-timestamps.js";
import type { ProviderSubagentUsage } from "../../../provider-subagents/store.js";
import { resolveObservedClaudeModelId } from "../models.js";
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
  /** Claude Code stamps the active effort on each assistant entry. */
  effort?: unknown;
  message?: { content?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * Last-observed model and effort from a subagent's own assistant entries.
 *
 * Effort is replay-only: the SDK's live assistant message does not carry it, and it can be
 * silently downgraded for the selected model, so any live value would be a guess.
 */
function readRuntime(entries: readonly ClaudeReplayEntry[]): { model?: string; effort?: string } {
  const runtime: { model?: string; effort?: string } = {};
  for (const entry of entries) {
    if (entry.type !== "assistant") continue;
    const effort = typeof entry.effort === "string" ? entry.effort.trim() : "";
    if (effort) runtime.effort = effort;
    const rawModel = (entry.message as { model?: unknown } | undefined)?.model;
    const model = resolveObservedClaudeModelId(typeof rawModel === "string" ? rawModel : undefined);
    if (model) runtime.model = model;
  }
  return runtime;
}

/**
 * Token counters as Claude Code stamps them onto an assistant entry. Undocumented internals, so
 * every field is optional and a wrong-typed field reads as absent rather than failing the entry.
 */
const ClaudeReplayUsageSchema = z.object({
  input_tokens: z.number().optional().catch(undefined),
  cache_creation_input_tokens: z.number().optional().catch(undefined),
  cache_read_input_tokens: z.number().optional().catch(undefined),
  output_tokens: z.number().optional().catch(undefined),
});

/**
 * The one number the live path calls `total_tokens`.
 *
 * This is not a guess. Claude Code 2.1.220 finalizes a subagent by summing the usage block of the
 * LAST assistant message — `input + (cache_creation ?? 0) + (cache_read ?? 0) + output` — and ships
 * that as `usage.total_tokens` on `task_notification`; `task_progress` reports the same sum from
 * the live tracker as it climbs. So it is a context-size reading at the final turn, not a
 * cumulative spend across turns, which is why a small subagent reports a number in the tens of
 * thousands: the reused prompt cache dominates it. Summing per-entry usage instead would multiply
 * the cached prefix by the turn count and report a number several times larger than the live path.
 */
function readTotalTokens(raw: unknown): number | undefined {
  const parsed = ClaudeReplayUsageSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens } =
    parsed.data;
  const counters = [
    input_tokens,
    cache_creation_input_tokens,
    cache_read_input_tokens,
    output_tokens,
  ];
  // An object with none of the four counters is not a usage block; reporting 0 would claim the
  // subagent spent nothing.
  if (counters.every((counter) => counter === undefined)) return undefined;
  return counters.reduce((total: number, counter) => total + (counter ?? 0), 0);
}

function countToolUses(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    if ((block as { type?: unknown }).type === "tool_use") count++;
  }
  return count;
}

/**
 * Cost of a subagent's run, recovered from its own transcript.
 *
 * Descriptors are in-memory and dropped when the agent closes, so without this a reopened agent
 * permanently loses its children's counters. The live path gets these numbers handed to it by
 * Claude Code; here they are re-derived to match those definitions:
 *
 *   totalTokens  last assistant entry's summed usage — exact (see readTotalTokens)
 *   toolUses     tool_use blocks across assistant entries — exact, same traversal
 *   durationMs   last entry timestamp minus first — an approximation: the live value is measured
 *                from task start to task end, and the transcript's first entry is written slightly
 *                after the task starts, so this reads a touch short.
 *
 * A field only appears when the transcript actually shows it. Absent means "not observed", and the
 * store merges usage field-by-field, so a partial report never blanks what is already there.
 */
function readUsage(entries: readonly ClaudeReplayEntry[]): ProviderSubagentUsage | null {
  let sawAssistant = false;
  let toolUses = 0;
  let totalTokens: number | undefined;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;

  for (const entry of entries) {
    const timestamp = normalizeProviderReplayTimestamp(entry.timestamp);
    if (timestamp) {
      firstTimestamp ??= timestamp;
      lastTimestamp = timestamp;
    }
    if (entry.type !== "assistant") continue;
    sawAssistant = true;
    toolUses += countToolUses(entry.message?.content);
    const observed = readTotalTokens(entry.message?.usage);
    if (observed !== undefined) totalTokens = observed;
  }

  const usage: ProviderSubagentUsage = {};
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  // Zero tool uses is a real observation, but only once the child has spoken at all.
  if (sawAssistant) usage.toolUses = toolUses;
  if (firstTimestamp && lastTimestamp) {
    const durationMs = Date.parse(lastTimestamp) - Date.parse(firstTimestamp);
    // A single timestamped entry yields 0, which is a measurement failure rather than an instant
    // run. Leave it absent so the store keeps whatever it had.
    if (durationMs > 0) usage.durationMs = durationMs;
  }
  return Object.keys(usage).length > 0 ? usage : null;
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

/**
 * The parent's tool input is the same source the live path reads, so it wins; meta.json fills the
 * gap when the parent's Task call is missing from the transcript.
 */
function declareSubagent(
  subagent: ClaudeReplaySubagentInput,
  link: ResolvedLink,
  toolCall: { title?: string; description?: string } | undefined,
): SubagentObservation {
  const title = toolCall?.title ?? subagent.meta?.agentType;
  const description = toolCall?.description ?? subagent.meta?.description;
  const firstTimestamp = normalizeProviderReplayTimestamp(subagent.entries[0]?.timestamp);
  return {
    kind: "declared",
    id: link.id,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(link.toolCallId ? { toolCallId: link.toolCallId } : {}),
    ...(firstTimestamp ? { timestamp: firstTimestamp } : {}),
  };
}

function observeSubagent(
  subagent: ClaudeReplaySubagentInput,
  parent: ClaudeReplayParentFacts,
  convertEntry: (entry: ClaudeReplayEntry) => AgentTimelineItem[],
): SubagentObservation[] {
  const link = resolveLink(subagent, parent);
  const toolCall = link.toolCallId ? parent.toolCalls.get(link.toolCallId) : undefined;

  const observations: SubagentObservation[] = [declareSubagent(subagent, link, toolCall)];

  // Never inherited from the parent: an unobserved value stays absent so the store's sticky
  // merge keeps whatever it already had.
  const runtime = readRuntime(subagent.entries);
  if (runtime.model !== undefined || runtime.effort !== undefined) {
    observations.push({ kind: "runtime", id: link.id, ...runtime });
  }

  const usage = readUsage(subagent.entries);
  if (usage) {
    // Stamp the run's end, not replay time, so a rebuilt descriptor does not look freshly active.
    const lastTimestamp = normalizeProviderReplayTimestamp(subagent.entries.at(-1)?.timestamp);
    observations.push({
      kind: "usage",
      id: link.id,
      usage,
      ...(lastTimestamp ? { timestamp: lastTimestamp } : {}),
    });
  }

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
