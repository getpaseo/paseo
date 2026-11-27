import {
  type MatchClass,
  scoreMatch,
  textFieldsMatchClass,
  tokenizeQuery,
} from "@getpaseo/protocol/search/text-match";
import type { CommandCenterContribution } from "./contributions";
import type { CommandCenterListMetrics } from "./list-metrics";

/** Sections pinned above every contribution section. */
export const LEADING_SECTION_BAND = -1;
/** Sections that reorder by how well they match the query. */
export const CONTRIBUTION_SECTION_BAND = 0;
/** Sections pinned below every contribution section regardless of match quality. */
export const PINNED_SECTION_BAND = 1;

/** Every query token matched something the user can read on the row. */
const VISIBLE_FIELD_RANK = 0;
/** At least one token only matched a hidden keyword. */
const KEYWORD_FIELD_RANK = 1;

/**
 * Left-edge match ranks for Command Center scoring, best to worst.
 *
 * Right-edge promotions (`TIER_EXACT`, `TIER_WHOLE_WORD`) are deliberately excluded here:
 * whether a word or title happens to end on the latest keystroke flips row order mid-word as
 * the user types (e.g., `"renam"` → `"rename"` jumping a shorter title ahead of `"Rename
 * workspace"`, or `"t"` → `"to"` jumping `"Pin to top"` ahead of `"Toggle Explorer sidebar"`).
 * Left-edge ranks can only stay the same or worsen as characters are appended to a token, so
 * two rows that keep matching at the same left edge never swap places.
 */
const FIELD_START_RANK = 0;
const WORD_START_RANK = 1;
const INSIDE_WORD_RANK = 2;
const SCATTERED_RANK = 3;

export interface CommandCenterScore {
  /** VISIBLE_FIELD_RANK or KEYWORD_FIELD_RANK. Compared before match quality. */
  fieldRank: number;
  /** Sum of per-token left-edge ranks (FIELD_START..SCATTERED). Lower is better. */
  matchRank: number;
}

/**
 * Rank by which fields matched before ranking by how well they matched. A row whose visible
 * label matches always outranks one that only matches through a hidden keyword, however good
 * the keyword match is.
 *
 * Scoring purely by tier is not enough: "aut" is a string-prefix of both "Auto mode" and
 * Schedules' hidden keyword "automation", so the tiers tie and the order falls back to group
 * rank, which puts Schedules first. It only came out right at the full word "auto". Order that
 * flips mid-word as you type is worse than order that is merely wrong.
 *
 * The cost is deliberate: an exact hidden-keyword match now loses to any visible match. No
 * query over the contributions registered today hits that case — hidden keywords here are
 * synonyms nothing else displays ("automation", "recurring", "repo", "shell", "hotkeys").
 */
export function compareCommandCenterScores(
  left: CommandCenterScore,
  right: CommandCenterScore,
): number {
  return left.fieldRank - right.fieldRank || left.matchRank - right.matchRank;
}

export interface CommandCenterWorkspaceProject {
  viewKey: string;
  name: string;
  iconDataUri: string | null;
}

/** An agent a workspace can be found by. Agents are never results of their own. */
export interface CommandCenterWorkspaceAgent {
  id: string;
  title: string;
  provider: string;
}

export interface CommandCenterWorkspaceResult {
  kind: "workspace";
  id: string;
  title: string;
  subtitle: string;
  serverId: string;
  workspaceId: string;
  project: CommandCenterWorkspaceProject;
  /** PR/MR number backing this workspace, so a number query can match it exactly. */
  changeRequestNumber: number | null;
  /** Last activity, or when it was archived for an archived workspace. */
  activityAt: Date | null;
  /** The workspace's agents, most recent first. Part of what the workspace matches on. */
  agents: readonly CommandCenterWorkspaceAgent[];
  /** The agent the query matched better than the workspace's own text. Drawn as a third line. */
  matchedAgent: CommandCenterWorkspaceAgent | null;
  archived: boolean;
  /** Started by automation rather than the user. Found by a query, never listed as recent. */
  background: boolean;
  /** Opens the workspace and lets its default tab selection apply. */
  run(): void;
  /** Opens the workspace on this agent's tab. */
  openAgent(agentId: string): void;
}

export interface CommandCenterFileResult {
  kind: "file";
  id: string;
  filePath: string;
  title: string;
  subtitle: string;
  run(): void;
}

export interface CommandCenterContributionResult {
  kind: "contribution";
  id: string;
  contribution: CommandCenterContribution;
  /** How well this row matches the query. Absent when the query is empty. */
  score?: CommandCenterScore;
  run(): void | Promise<void>;
}

export type CommandCenterResult =
  | CommandCenterWorkspaceResult
  | CommandCenterFileResult
  | CommandCenterContributionResult;

export interface CommandCenterResultSection {
  id: string;
  /** LEADING, CONTRIBUTION or PINNED_SECTION_BAND. Compared before anything else. */
  band: number;
  rank: number;
  title?: string;
  /** Best score among this section's results. Absent when the query is empty. */
  score?: CommandCenterScore;
  results: readonly CommandCenterResult[];
}

interface MutableCommandCenterResultSection {
  id: string;
  band: number;
  rank: number;
  title?: string;
  score?: CommandCenterScore;
  results: CommandCenterResult[];
}

export type CommandCenterListRow =
  | { kind: "section"; key: string; title?: string; divider: boolean; height: number }
  | { kind: "result"; key: string; result: CommandCenterResult; height: number };

export interface CommandCenterListProjection {
  rows: readonly CommandCenterListRow[];
  selectableResults: readonly CommandCenterResult[];
  rowIndexByResultId: ReadonlyMap<string, number>;
  offsets: readonly number[];
}

/**
 * Fields a row can be matched on, split by whether the user can read them. A row that matches
 * only through `hidden` still matches, but always ranks below one whose `visible` text did.
 */
export interface CommandCenterSearchFields {
  visible: readonly string[];
  hidden: readonly string[];
}

function scoreTokenInField(token: string, field: string): number | null {
  // Check start-of-field first: `scoreMatch` prefers a later whole word (tier 1) over a leading
  // prefix (tier 2), which would otherwise demote a field starting with the token when the same
  // token also appears as a standalone word later in the field.
  if (field.toLowerCase().startsWith(token)) return FIELD_START_RANK;
  const score = scoreMatch(token, field);
  if (!score) return null;
  if (score.tier <= 3) return WORD_START_RANK;
  if (score.tier === 4) return INSIDE_WORD_RANK;
  return SCATTERED_RANK;
}

function scoreFieldsLeftEdge(tokens: readonly string[], fields: readonly string[]): number | null {
  let total = 0;
  for (const token of tokens) {
    let best: number | null = null;
    for (const field of fields) {
      const rank = scoreTokenInField(token, field);
      if (rank !== null && (best === null || rank < best)) {
        best = rank;
        if (best === FIELD_START_RANK) break;
      }
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}

/**
 * The one definition of "how well did this row match", shared by every scored row kind. Null
 * means the row is filtered out, so scoring and filtering are the same pass — a separate boolean
 * predicate would throw this result away and force the token scan a second time.
 *
 * Matching is per-token (`tokenizeQuery` splits on whitespace and every token must land in
 * some field), so token order does not matter and `lab des` finds "Label as Design". This can
 * only ever widen the result set: tokens hold no whitespace, so any token that was found in the
 * old space-joined haystack lies entirely within one field and is still found here.
 *
 * Subsequence matches stay within each word, so `lbl dsgn` finds "Label as Design"
 * while `labdes` cannot assemble a match across those words.
 */
export function scoreSearchFields(
  query: string,
  fields: CommandCenterSearchFields,
): CommandCenterScore | null {
  const tokens = tokenizeQuery(query);
  const visible = scoreFieldsLeftEdge(tokens, fields.visible);
  if (visible !== null) return { fieldRank: VISIBLE_FIELD_RANK, matchRank: visible };
  if (fields.hidden.length === 0) return null;
  const matchRank = scoreFieldsLeftEdge(tokens, [...fields.visible, ...fields.hidden]);
  return matchRank !== null ? { fieldRank: KEYWORD_FIELD_RANK, matchRank } : null;
}

/** How closely the query matched the fields; see `MatchClass`. Null when it does not match. */
export function searchFieldsMatchClass(
  query: string,
  fields: CommandCenterSearchFields,
): MatchClass | null {
  return textFieldsMatchClass(query, [...fields.visible, ...fields.hidden]);
}

/** Join non-empty subtitle parts with " · ", dropping null/undefined/empty. */
export function joinSubtitleParts(parts: readonly (string | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

/**
 * Field order carries no meaning: every token is scored against each field on its own, so
 * ["Mode", "Auto mode"] and its reverse both match "mode auto" and "auto mode".
 */
function contributionSearchFields(
  contribution: CommandCenterContribution,
): CommandCenterSearchFields {
  const visible =
    contribution.presentation.kind === "action"
      ? [contribution.presentation.title, contribution.presentation.subtitle ?? ""]
      : [...contribution.presentation.path];
  return { visible, hidden: contribution.keywords };
}

/** How many lines of text the row draws, which decides its height. */
function resultLineCount(result: CommandCenterResult): 1 | 2 | 3 {
  if (result.kind === "workspace") return result.matchedAgent ? 3 : 2;
  if (result.kind === "file") return 1;
  const presentation = result.contribution.presentation;
  return presentation.kind === "action" && presentation.subtitle ? 2 : 1;
}

function resultHeight(result: CommandCenterResult, metrics: CommandCenterListMetrics): number {
  const lines = resultLineCount(result);
  if (lines === 3) return metrics.threeLineRow;
  return lines === 2 ? metrics.twoLineRow : metrics.singleLineRow;
}

/**
 * Order two sections. Total and transitive: the mixed case (one score present, one absent)
 * cannot occur, because scores exist exactly on band-0 sections with a non-empty query, band is
 * compared first so cross-band pairs never reach the score clause, and within band 0 either
 * every section has a score or none does.
 */
function compareResultSections(
  left: CommandCenterResultSection,
  right: CommandCenterResultSection,
): number {
  if (left.band !== right.band) return left.band - right.band;
  if (left.score && right.score) {
    const delta = compareCommandCenterScores(left.score, right.score);
    if (delta !== 0) return delta;
  }
  return left.rank - right.rank || left.id.localeCompare(right.id);
}

function resultScore(result: CommandCenterResult): CommandCenterScore | undefined {
  return result.kind === "contribution" ? result.score : undefined;
}

/** A built-in row that orders by how recently it saw activity. */
export interface CommandCenterRecentRow {
  activityAt: Date | null;
}

/** Most recent first. A row with no timestamp sorts after every row that has one. */
export function compareByRecency(left: CommandCenterRecentRow, right: CommandCenterRecentRow) {
  return (right.activityAt?.getTime() ?? 0) - (left.activityAt?.getTime() ?? 0);
}

/**
 * Group contributions into their sections, ranked by the query. `includeQueryOnly` lists the
 * contributions that otherwise wait for a query, for a list whose whole job is browsing them.
 */
export function buildContributionSections(
  contributions: readonly CommandCenterContribution[],
  query: string,
  options: { includeQueryOnly?: boolean } = {},
): CommandCenterResultSection[] {
  const groups = new Map<string, MutableCommandCenterResultSection>();
  const registryIndexById = new Map<string, number>();
  const hasQuery = Boolean(query.trim());

  for (const [index, contribution] of contributions.entries()) {
    if (contribution.visibility === "query" && !hasQuery && !options.includeQueryOnly) continue;
    let score: CommandCenterScore | undefined;
    if (hasQuery) {
      // The score is the filter: null means no token found a home, so the row is out.
      const matched = scoreSearchFields(query, contributionSearchFields(contribution));
      if (!matched) continue;
      score = matched;
    }
    const existing = groups.get(contribution.group);
    const title =
      contribution.presentation.kind === "action"
        ? contribution.presentation.sectionTitle
        : undefined;
    const section = existing ?? {
      id: contribution.group,
      band: CONTRIBUTION_SECTION_BAND,
      rank: contribution.groupRank,
      title,
      results: [],
    };
    registryIndexById.set(contribution.id, index);
    section.results.push({
      kind: "contribution",
      id: contribution.id,
      contribution,
      score,
      run: contribution.run,
    });
    if (score && (!section.score || compareCommandCenterScores(score, section.score) < 0)) {
      section.score = score;
    }
    groups.set(contribution.group, section);
  }

  const sections = [...groups.values()];
  // With no query there is nothing to rank by, so leave the registry order untouched.
  if (!hasQuery) return sections;

  for (const section of sections) {
    section.results.sort((left, right) => {
      const leftScore = resultScore(left);
      const rightScore = resultScore(right);
      const delta = leftScore && rightScore ? compareCommandCenterScores(leftScore, rightScore) : 0;
      if (delta !== 0) return delta;
      return (registryIndexById.get(left.id) ?? 0) - (registryIndexById.get(right.id) ?? 0);
    });
  }
  return sections.sort(compareResultSections);
}

export function projectCommandCenterRows(
  sections: readonly CommandCenterResultSection[],
  metrics: CommandCenterListMetrics,
): CommandCenterListProjection {
  const populated = sections
    .filter((section) => section.results.length > 0)
    .sort(compareResultSections);
  const rows: CommandCenterListRow[] = [];
  const selectableResults: CommandCenterResult[] = [];
  const rowIndexByResultId = new Map<string, number>();
  const offsets: number[] = [];
  let offset = 0;

  for (const [sectionIndex, section] of populated.entries()) {
    const divider = sectionIndex > 0;
    const sectionHeight =
      (divider ? metrics.sectionDivider : 0) + (section.title ? metrics.sectionTitle : 0);
    if (sectionHeight > 0) {
      offsets.push(offset);
      rows.push({
        kind: "section",
        key: `section:${section.id}`,
        title: section.title,
        divider,
        height: sectionHeight,
      });
      offset += sectionHeight;
    }
    for (const result of section.results) {
      const height = resultHeight(result, metrics);
      offsets.push(offset);
      rowIndexByResultId.set(result.id, rows.length);
      rows.push({ kind: "result", key: result.id, result, height });
      selectableResults.push(result);
      offset += height;
    }
  }

  return { rows, selectableResults, rowIndexByResultId, offsets };
}

export function preserveActiveResultId(
  activeId: string | null,
  results: readonly CommandCenterResult[],
): string | null {
  if (activeId && results.some((result) => result.id === activeId)) return activeId;
  return results[0]?.id ?? null;
}

export function moveActiveResultId(
  activeId: string | null,
  results: readonly CommandCenterResult[],
  direction: "next" | "previous",
): string | null {
  if (results.length === 0) return null;
  const current = results.findIndex((result) => result.id === activeId);
  const delta = direction === "next" ? 1 : -1;
  let start = current;
  if (current < 0 && direction === "previous") start = 0;
  const next = (start + delta + results.length) % results.length;
  return results[next].id;
}
