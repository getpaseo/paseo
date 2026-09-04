import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import {
  compareMatchScores,
  type MatchScore,
  scoreTextFields,
} from "@getpaseo/protocol/search/text-match";
import type { CommandCenterContribution } from "./contributions";

/** Sections that reorder by how well they match the query. */
export const CONTRIBUTION_SECTION_BAND = 0;
/** Sections pinned below every contribution section regardless of match quality. */
export const PINNED_SECTION_BAND = 1;

/** Every query token matched something the user can read on the row. */
const VISIBLE_FIELD_RANK = 0;
/** At least one token only matched a hidden keyword. */
const KEYWORD_FIELD_RANK = 1;

export interface CommandCenterScore {
  /** VISIBLE_FIELD_RANK or KEYWORD_FIELD_RANK. Compared before match quality. */
  fieldRank: number;
  match: MatchScore;
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
  return left.fieldRank - right.fieldRank || compareMatchScores(left.match, right.match);
}

export interface CommandCenterWorkspaceResult {
  kind: "workspace";
  id: string;
  title: string;
  subtitle: string;
  /** PR/MR number backing this workspace, so a number query can match it exactly. */
  changeRequestNumber: number | null;
  run(): void;
}

export interface CommandCenterAgentResult {
  kind: "agent";
  id: string;
  agent: AggregatedAgent;
  title: string;
  subtitle: string;
  run(): void;
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
  | CommandCenterAgentResult
  | CommandCenterFileResult
  | CommandCenterContributionResult;

export interface CommandCenterResultSection {
  id: string;
  /** CONTRIBUTION_SECTION_BAND or PINNED_SECTION_BAND. Compared before anything else. */
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

const MATCH_OPTIONS = { subsequence: false } as const;

/**
 * The one definition of "how well did this row match", shared by every scored row kind. Null
 * means the row is filtered out, so scoring and filtering are the same pass — a separate boolean
 * predicate would throw this result away and force the token scan a second time.
 *
 * Matching is per-token (`scoreTextFields` splits on whitespace and every token must land in
 * some field), so token order does not matter and `lab des` finds "Label as Design". This can
 * only ever widen the result set: tokens hold no whitespace, so any token that was found in the
 * old space-joined haystack lies entirely within one field and is still found here.
 *
 * Subsequence matching is off, unlike the composer's slash-command list. Each token has to be a
 * run of adjacent characters, so `lab des` matches and `labdes` does not. It widens hard enough
 * that almost any typo finds something, and this list preselects its first row: a query the user
 * expects to find nothing would instead put an unrelated action under Enter.
 */
export function scoreSearchFields(
  query: string,
  fields: CommandCenterSearchFields,
): CommandCenterScore | null {
  const visible = scoreTextFields(query, [...fields.visible], MATCH_OPTIONS);
  if (visible) return { fieldRank: VISIBLE_FIELD_RANK, match: visible };
  if (fields.hidden.length === 0) return null;
  const match = scoreTextFields(query, [...fields.visible, ...fields.hidden], MATCH_OPTIONS);
  return match ? { fieldRank: KEYWORD_FIELD_RANK, match } : null;
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

function resultHeight(result: CommandCenterResult): number {
  if (result.kind === "workspace" || result.kind === "agent") return 56;
  if (result.kind === "file") return 36;
  if (result.contribution.presentation.kind === "action") {
    return result.contribution.presentation.subtitle ? 56 : 36;
  }
  return 36;
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

/** Rows shown when nothing has been typed, per pinned category. */
const DEFAULT_CATEGORY_RESULT_LIMIT = 5;

/**
 * Filter and rank already-built rows. Rows in, rows out — building them needs translations,
 * navigation callbacks and the project tree, none of which matching cares about, so that stays
 * with the caller and this stays testable without mounting React.
 *
 * `tiebreak` is the caller's own ordering (alphabetical for workspaces, status and recency for
 * agents). It decides equal-scoring rows, so an agent awaiting input still outranks an idle one
 * that matched exactly as well.
 */
export function filterAndRankBuiltInResults<Row>(
  rows: readonly Row[],
  query: string,
  fieldsOf: (row: Row) => CommandCenterSearchFields,
  tiebreak: (left: Row, right: Row) => number,
): Row[] {
  if (!query.trim()) return rows.slice(0, DEFAULT_CATEGORY_RESULT_LIMIT);

  const scored: { row: Row; score: CommandCenterScore }[] = [];
  for (const row of rows) {
    const score = scoreSearchFields(query, fieldsOf(row));
    if (score) scored.push({ row, score });
  }
  scored.sort(
    (left, right) =>
      compareCommandCenterScores(left.score, right.score) || tiebreak(left.row, right.row),
  );
  return scored.map((entry) => entry.row);
}

export function buildContributionSections(
  contributions: readonly CommandCenterContribution[],
  query: string,
): CommandCenterResultSection[] {
  const groups = new Map<string, MutableCommandCenterResultSection>();
  const registryIndexById = new Map<string, number>();
  const hasQuery = Boolean(query.trim());

  for (const [index, contribution] of contributions.entries()) {
    if (contribution.visibility === "query" && !hasQuery) continue;
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
    let sectionHeight = 0;
    if (section.title && divider) sectionHeight = 49;
    if (section.title && !divider) sectionHeight = 32;
    if (!section.title && divider) sectionHeight = 17;
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
      const height = resultHeight(result);
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
