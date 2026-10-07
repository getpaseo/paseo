import { z } from "zod";

import type { AgentTimelineItem } from "../../../agent-sdk-types.js";
import { normalizeProviderReplayTimestamp } from "../../../provider-history-timestamps.js";
import type { ProviderSubagentStatus } from "../../../provider-subagents/store.js";
import { resolveObservedClaudeModelId } from "../models.js";
import type { SubagentObservation } from "./observation.js";
import { buildClaudeSubagentSubtitle, type ClaudeSubagentUsage } from "./presentation.js";

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
function readRuntime(entry: ClaudeReplayEntry): { model?: string; effort?: string } {
  if (entry.type !== "assistant") return {};
  const effort = typeof entry.effort === "string" ? entry.effort.trim() : "";
  const rawModel = entry.message?.model;
  const model = resolveObservedClaudeModelId(typeof rawModel === "string" ? rawModel : undefined);
  return { ...(effort ? { effort } : {}), ...(model ? { model } : {}) };
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

/**
 * Token context of a subagent's run, recovered from its own transcript.
 *
 * Descriptors are in-memory and dropped when the agent closes, so without this a reopened agent
 * permanently loses its children's counters. The live path gets these numbers handed to it by
 * Claude Code; here they are re-derived to match those definitions:
 *
 * The last assistant entry's summed usage matches Claude Code's live `total_tokens` definition.
 */
function readUsage(entry: ClaudeReplayEntry): ClaudeSubagentUsage | null {
  if (entry.type !== "assistant") return null;
  const totalTokens = readTotalTokens(entry.message?.usage);
  return totalTokens === undefined ? null : { totalTokens };
}

export interface ClaudeReplaySubagentInput {
  agentId: string;
  meta: ClaudeSubagentMeta | null;
  entries: Iterable<ClaudeReplayEntry>;
  /** Task declarations made by this subagent, used to attach its direct children. */
  parentFacts?: ClaudeReplayParentFacts;
}

export interface ClaudeReplayParentFacts {
  /** Task `tool_use` id -> identity declared in the parent's tool input. */
  toolCalls: ReadonlyMap<string, { title?: string; description?: string }>;
  /** agentId -> tool call, recovered by scraping tool-result text. Legacy fallback only. */
  linksByAgentId: ReadonlyMap<string, { toolCallId: string; failed: boolean }>;
  /** Task `tool_use` id -> outcome. Usable once meta.json supplies the link directly. */
  outcomesByToolCallId: ReadonlyMap<string, { failed: boolean }>;
}

interface ParentLink {
  id: string;
  toolCallId: string;
  /** Terminal status recorded by the parent, or null when its Task has no outcome yet. */
  status: ProviderSubagentStatus | null;
}

/**
 * Resolve a child only when the parent transcript declares the corresponding Task.
 *
 * `meta.toolUseId` is authoritative for identity — it is the same id the live stream keys on. The
 * legacy path scrapes `agentId:` out of stringified tool-result content, which both misses the link
 * when the parent's tool_result is absent and matches unrelated text — on a real five-subagent
 * session it produced eight ids, inventing `z`, `string`, and `update`. It stays only as a fallback
 * for sessions recorded before the meta file existed.
 *
 * ```
 * meta.toolUseId matches a parent Task?
 * ├─ yes → use it and the parent's outcome, when present
 * └─ no  → a legacy scraped agentId link matches a parent Task?
 *           ├─ yes → use it and its recorded outcome
 *           └─ no  → drop it; live never declared this child either
 * ```
 *
 * Claude writes grandchildren and skill-owned sidechains beside direct children. Admitting those
 * without a parent Task creates replay-only rows with no identity or lifecycle source. Filtering
 * here keeps live and replay on the same declaration boundary.
 */
function resolveParentLink(
  subagent: ClaudeReplaySubagentInput,
  parent: ClaudeReplayParentFacts,
): ParentLink | null {
  const metaToolUseId = subagent.meta?.toolUseId?.trim();
  if (metaToolUseId && parent.toolCalls.has(metaToolUseId)) {
    const outcome = parent.outcomesByToolCallId.get(metaToolUseId);
    let status: ProviderSubagentStatus | null = null;
    if (outcome) status = outcome.failed ? "failed" : "completed";
    return {
      id: metaToolUseId,
      toolCallId: metaToolUseId,
      status,
    };
  }

  const scraped = parent.linksByAgentId.get(subagent.agentId);
  if (scraped && parent.toolCalls.has(scraped.toolCallId)) {
    return {
      id: scraped.toolCallId,
      toolCallId: scraped.toolCallId,
      status: scraped.failed ? "failed" : "completed",
    };
  }

  return null;
}

/**
 * The parent's tool input is the same identity source the live path reads; meta.json contributes
 * provider details only after that declaration has admitted the child.
 */
function declareSubagent(
  subagent: ClaudeReplaySubagentInput,
  link: ParentLink,
  toolCall: { title?: string; description?: string } | undefined,
  parentSubagentId: string | undefined,
  firstTimestamp: string | null,
): SubagentObservation {
  const title = toolCall?.title ?? subagent.meta?.agentType;
  const description = toolCall?.description ?? subagent.meta?.description;
  return {
    kind: "declared",
    id: link.id,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(link.toolCallId ? { toolCallId: link.toolCallId } : {}),
    ...(parentSubagentId ? { parentSubagentId } : {}),
    ...(firstTimestamp ? { timestamp: firstTimestamp } : {}),
  };
}

function observeSubtitle(
  link: ParentLink,
  title: string | undefined,
  runtime: { model?: string; effort?: string },
  usage: ClaudeSubagentUsage | null,
  timestamp: string | null,
): SubagentObservation | null {
  const hasDetails =
    runtime.model !== undefined ||
    runtime.effort !== undefined ||
    (usage?.totalTokens !== undefined && usage.totalTokens > 0);
  if (!hasDetails) return null;
  const subtitle = buildClaudeSubagentSubtitle({
    title,
    ...runtime,
    ...(usage ? { usage } : {}),
  });
  if (!subtitle) return null;
  return {
    kind: "subtitle",
    id: link.id,
    subtitle,
    ...(timestamp ? { timestamp } : {}),
  };
}

function observeSubagent(
  subagent: ClaudeReplaySubagentInput,
  parent: ClaudeReplayParentFacts,
  convertEntry: (entry: ClaudeReplayEntry) => AgentTimelineItem[],
  toolOwners: Map<string, string>,
  parentSubagentId?: string,
): SubagentObservation[] {
  const link = resolveParentLink(subagent, parent);
  if (!link) return [];
  const toolCall = parent.toolCalls.get(link.toolCallId);
  const timeline: SubagentObservation[] = [];
  const runtime: { model?: string; effort?: string } = {};
  let usage: ClaudeSubagentUsage | null = null;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  let seenEntry = false;
  let childTerminalStatus: ProviderSubagentStatus | null = null;

  // Consume each source once for presentation and timeline; keep no raw transcript records.
  for (const entry of subagent.entries) {
    const timestamp = normalizeProviderReplayTimestamp(entry.timestamp);
    if (!seenEntry) firstTimestamp = timestamp;
    seenEntry = true;
    lastTimestamp = timestamp;
    Object.assign(runtime, readRuntime(entry));
    usage = readUsage(entry) ?? usage;
    if (entry.type === "assistant") {
      childTerminalStatus = entry.message?.stop_reason === "end_turn" ? "completed" : null;
    }
    recordReplayToolOwners(toolOwners, entry, link.id);
    for (const item of convertEntry(entry)) {
      timeline.push({ kind: "timeline", id: link.id, item, ...(timestamp ? { timestamp } : {}) });
    }
  }
  const observations = [
    declareSubagent(subagent, link, toolCall, parentSubagentId, firstTimestamp),
  ];
  const subtitle = observeSubtitle(
    link,
    toolCall?.title ?? subagent.meta?.agentType,
    runtime,
    usage,
    lastTimestamp,
  );
  if (subtitle) observations.push(subtitle);
  observations.push(...timeline);
  const terminalStatus = link.status ?? childTerminalStatus;
  if (terminalStatus) {
    observations.push({
      kind: "status",
      id: link.id,
      status: terminalStatus,
      ...(lastTimestamp ? { timestamp: lastTimestamp } : {}),
    });
  }
  return observations;
}

function recordReplayToolOwners(
  owners: Map<string, string>,
  entry: ClaudeReplayEntry,
  subagentId: string,
): void {
  if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) return;
  for (const block of entry.message.content) {
    if (block?.type === "tool_use" && typeof block.id === "string")
      owners.set(block.id, subagentId);
  }
}

export function observeReplaySubagents(input: {
  subagents: readonly ClaudeReplaySubagentInput[];
  parent: ClaudeReplayParentFacts;
  convertEntry: (entry: ClaudeReplayEntry) => AgentTimelineItem[];
}): { observations: SubagentObservation[]; toolOwners: ReadonlyMap<string, string> } {
  const observations: SubagentObservation[] = [];
  const toolOwners = new Map<string, string>();
  const unresolved = [...input.subagents].sort(
    (left, right) => (left.meta?.spawnDepth ?? 1) - (right.meta?.spawnDepth ?? 1),
  );
  const resolvedParents = new Map<string, ClaudeReplayParentFacts>();

  // Claude stores every descendant beside the root transcript. Resolve one generation at a
  // time: a child is admitted only when its tool id is declared by a transcript whose own parent
  // has already been proven. This preserves the old boundary against unrelated ambient sidecars.
  let madeProgress = true;
  while (unresolved.length > 0 && madeProgress) {
    madeProgress = false;
    for (let index = unresolved.length - 1; index >= 0; index--) {
      const subagent = unresolved[index];
      if (!subagent) continue;
      const resolved = resolveReplayOwner(subagent, input.parent, resolvedParents);
      if (!resolved) continue;
      const { ownerId, parent, link } = resolved;

      // Only proven descendants may own notifications; ambient sidecars cannot claim them.
      observations.push(
        ...observeSubagent(subagent, parent, input.convertEntry, toolOwners, ownerId),
      );
      if (subagent.parentFacts) resolvedParents.set(link.id, subagent.parentFacts);
      unresolved.splice(index, 1);
      madeProgress = true;
    }
  }
  return { observations, toolOwners };
}

function resolveReplayOwner(
  subagent: ClaudeReplaySubagentInput,
  rootParent: ClaudeReplayParentFacts,
  resolvedParents: ReadonlyMap<string, ClaudeReplayParentFacts>,
): {
  ownerId?: string;
  parent: ClaudeReplayParentFacts;
  link: NonNullable<ReturnType<typeof resolveParentLink>>;
} | null {
  const rootLink = resolveParentLink(subagent, rootParent);
  if (rootLink) return { parent: rootParent, link: rootLink };

  for (const [ownerId, parent] of resolvedParents) {
    const link = resolveParentLink(subagent, parent);
    if (link) return { ownerId, parent, link };
  }
  return null;
}
