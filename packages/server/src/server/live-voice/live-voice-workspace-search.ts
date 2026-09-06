/**
 * Resolving a workspace the user said out loud into an id something can act on.
 *
 * The name arrives as speech, so it has been through a transcriber: casing,
 * punctuation and hyphens are not reliable, and the user says "the Refresh Paseo
 * assembly workspace" for a workspace titled "Refresh Paseo assembly" living in
 * `.../refresh-paseo-assembly`. Normalization folds all three onto the same
 * string so an exact match stays available for destructive actions.
 *
 * Nothing here decides anything. It classifies, and the caller and the model are
 * told to act only on `unique_exact` — two workspaces with the same title on two
 * machines must reach the user as a question, not a coin flip.
 */

export interface LiveVoiceWorkspaceCandidate {
  serverId: string;
  hostLabel: string;
  workspaceId: string;
  title: string | null;
  cwd: string | null;
}

export type LiveVoiceWorkspaceMatchKind = "exact" | "partial";

export interface LiveVoiceWorkspaceMatch extends LiveVoiceWorkspaceCandidate {
  matchKind: LiveVoiceWorkspaceMatchKind;
}

/**
 * `*_exact` means the spoken name matched a title or directory name outright;
 * `*_partial` means it only matched loosely. `unique_exact` is the only value
 * that identifies a workspace well enough to archive it without asking.
 */
export type LiveVoiceWorkspaceResolution =
  | "unique_exact"
  | "ambiguous_exact"
  | "unique_partial"
  | "ambiguous_partial"
  | "none";

export interface LiveVoiceWorkspaceSearchResult {
  resolution: LiveVoiceWorkspaceResolution;
  matches: LiveVoiceWorkspaceMatch[];
}

/** Long enough for the model to read a list back; short enough to stay speakable. */
const MAX_MATCHES = 20;

/**
 * Everything a transcriber varies is folded away: case, punctuation, hyphens,
 * underscores and repeated spaces. What survives is words and digits.
 */
export function normalizeWorkspaceName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  const normalized = normalizeWorkspaceName(value);
  return normalized.length === 0 ? [] : normalized.split(" ");
}

function basename(cwd: string): string {
  const segments = cwd.split(/[/\\]+/).filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? "";
}

/**
 * The title if the user gave one, plus the directory name — people name a
 * workspace by its folder as often as by its title, and an untitled workspace
 * has nothing else to be called.
 */
function candidateNames(candidate: LiveVoiceWorkspaceCandidate): string[] {
  const names: string[] = [];
  const title = candidate.title?.trim();
  if (title) {
    names.push(title);
  }
  const leaf = candidate.cwd ? basename(candidate.cwd) : "";
  if (leaf) {
    names.push(leaf);
  }
  return names;
}

function classify(
  candidate: LiveVoiceWorkspaceCandidate,
  normalizedQuery: string,
  queryTokens: string[],
): LiveVoiceWorkspaceMatchKind | null {
  const names = candidateNames(candidate);
  if (names.some((name) => normalizeWorkspaceName(name) === normalizedQuery)) {
    return "exact";
  }
  const partial = names.some((name) => {
    const normalizedName = normalizeWorkspaceName(name);
    if (normalizedName.length === 0) {
      return false;
    }
    if (normalizedName.includes(normalizedQuery)) {
      return true;
    }
    const nameTokens = new Set(tokenize(name));
    return queryTokens.every((token) => nameTokens.has(token));
  });
  return partial ? "partial" : null;
}

/**
 * Exact matches shadow partial ones entirely. Returning both tiers would hand
 * the model a list whose first entry is right and whose rest are noise, and the
 * cost of it picking wrong is an archived workspace.
 */
export function searchLiveVoiceWorkspaces(
  query: string,
  candidates: readonly LiveVoiceWorkspaceCandidate[],
): LiveVoiceWorkspaceSearchResult {
  const normalizedQuery = normalizeWorkspaceName(query);
  if (normalizedQuery.length === 0) {
    return { resolution: "none", matches: [] };
  }
  const queryTokens = tokenize(query);

  const exact: LiveVoiceWorkspaceMatch[] = [];
  const partial: LiveVoiceWorkspaceMatch[] = [];
  for (const candidate of candidates) {
    const matchKind = classify(candidate, normalizedQuery, queryTokens);
    if (matchKind === "exact") {
      exact.push({ ...candidate, matchKind });
    } else if (matchKind === "partial") {
      partial.push({ ...candidate, matchKind });
    }
  }

  if (exact.length > 0) {
    return {
      resolution: exact.length === 1 ? "unique_exact" : "ambiguous_exact",
      matches: exact.slice(0, MAX_MATCHES),
    };
  }
  if (partial.length > 0) {
    return {
      resolution: partial.length === 1 ? "unique_partial" : "ambiguous_partial",
      matches: partial.slice(0, MAX_MATCHES),
    };
  }
  return { resolution: "none", matches: [] };
}
