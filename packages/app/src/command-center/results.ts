import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { CommandCenterContribution } from "./contributions";

export interface CommandCenterWorkspaceResult {
  kind: "workspace";
  id: string;
  title: string;
  subtitle: string;
  searchText: string;
  run(): void;
}

export interface CommandCenterAgentResult {
  kind: "agent";
  id: string;
  agent: AggregatedAgent;
  title: string;
  subtitle: string;
  searchText: string;
  run(): void;
}

export interface CommandCenterContributionResult {
  kind: "contribution";
  id: string;
  contribution: CommandCenterContribution;
  searchText: string;
  run(): void | Promise<void>;
}

export type CommandCenterResult =
  | CommandCenterWorkspaceResult
  | CommandCenterAgentResult
  | CommandCenterContributionResult;

export interface CommandCenterResultSection {
  id: string;
  rank: number;
  title?: string;
  results: readonly CommandCenterResult[];
}

interface MutableCommandCenterResultSection {
  id: string;
  rank: number;
  title?: string;
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

function matchesQuery(searchText: string, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return !normalized || searchText.includes(normalized);
}

function contributionSearchText(contribution: CommandCenterContribution): string {
  const presentationText =
    contribution.presentation.kind === "action"
      ? [contribution.presentation.title, contribution.presentation.subtitle ?? ""]
      : contribution.presentation.path;
  return [...presentationText, ...contribution.keywords].join(" ").toLowerCase();
}

function resultHeight(result: CommandCenterResult): number {
  if (result.kind === "workspace" || result.kind === "agent") return 56;
  if (result.contribution.presentation.kind === "action") {
    return result.contribution.presentation.subtitle ? 56 : 36;
  }
  return 36;
}

export function buildContributionSections(
  contributions: readonly CommandCenterContribution[],
  query: string,
): CommandCenterResultSection[] {
  const groups = new Map<string, MutableCommandCenterResultSection>();
  const hasQuery = Boolean(query.trim());

  for (const contribution of contributions) {
    if (contribution.visibility === "query" && !hasQuery) continue;
    const searchText = contributionSearchText(contribution);
    if (!matchesQuery(searchText, query)) continue;
    const existing = groups.get(contribution.group);
    const title =
      contribution.presentation.kind === "action"
        ? contribution.presentation.sectionTitle
        : undefined;
    const section = existing ?? {
      id: contribution.group,
      rank: contribution.groupRank,
      title,
      results: [],
    };
    section.results.push({
      kind: "contribution",
      id: contribution.id,
      contribution,
      searchText,
      run: contribution.run,
    });
    groups.set(contribution.group, section);
  }

  return [...groups.values()].sort(
    (left, right) => left.rank - right.rank || left.id.localeCompare(right.id),
  );
}

export function projectCommandCenterRows(
  sections: readonly CommandCenterResultSection[],
): CommandCenterListProjection {
  const populated = sections
    .filter((section) => section.results.length > 0)
    .sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id));
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
