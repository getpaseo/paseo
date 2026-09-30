import type { SettingsPage, SettingsPageId } from "@/screens/settings/settings-pages";

export interface SettingsSearchDocument {
  pageId: SettingsPageId;
  title: string;
  sections: readonly string[];
  hints: readonly string[];
}

export interface SettingsSearchHit {
  pageId: SettingsPageId;
  title: string;
  /** The section or hint that matched, or null when the page title itself did. */
  detail: string | null;
}

// Case- and accent-insensitive, so "ubersicht" finds "Übersicht".
export function normalizeSearchText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

function tokenize(query: string): string[] {
  return normalizeSearchText(query).split(/\s+/).filter(Boolean);
}

function containsAll(text: string, tokens: readonly string[]): boolean {
  const normalized = normalizeSearchText(text);
  return tokens.every((token) => normalized.includes(token));
}

/** Every word of the query appears somewhere in the text. An empty query matches everything. */
export function matchesSearchQuery(text: string, query: string): boolean {
  return containsAll(text, tokenize(query));
}

export function buildSettingsSearchDocuments(
  pages: readonly SettingsPage[],
  translate: (key: string) => string,
): SettingsSearchDocument[] {
  return pages.map((page) => ({
    pageId: page.id,
    title: translate(page.labelKey),
    sections: page.sectionKeys.map(translate),
    // Arabic, Japanese and Chinese translators may use their own comma.
    hints: translate(page.hintsKey)
      .split(/[,،、，]/)
      .map((hint) => hint.trim())
      .filter(Boolean),
  }));
}

interface RankedHit {
  rank: number;
  hit: SettingsSearchHit;
}

function rankDocument(document: SettingsSearchDocument, tokens: string[]): RankedHit | null {
  const base = { pageId: document.pageId, title: document.title };
  if (containsAll(document.title, tokens)) {
    const isPrefix = normalizeSearchText(document.title).startsWith(tokens[0] ?? "");
    return { rank: isPrefix ? 0 : 1, hit: { ...base, detail: null } };
  }
  const section = document.sections.find((candidate) => containsAll(candidate, tokens));
  if (section) {
    return { rank: 2, hit: { ...base, detail: section } };
  }
  const hint = document.hints.find((candidate) => containsAll(candidate, tokens));
  if (hint) {
    return { rank: 3, hit: { ...base, detail: hint } };
  }
  const everything = [document.title, ...document.sections, ...document.hints].join(" ");
  if (containsAll(everything, tokens)) {
    return { rank: 4, hit: { ...base, detail: null } };
  }
  return null;
}

/** Pages whose title, sections or hints hold every query word; best field first, then page order. */
export function searchSettings(
  documents: readonly SettingsSearchDocument[],
  query: string,
): SettingsSearchHit[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return [];
  }
  const ranked: RankedHit[] = [];
  for (const document of documents) {
    const match = rankDocument(document, tokens);
    if (match) ranked.push(match);
  }
  // Array.prototype.sort is stable, so equal ranks keep navigation order.
  return ranked.sort((a, b) => a.rank - b.rank).map((entry) => entry.hit);
}
