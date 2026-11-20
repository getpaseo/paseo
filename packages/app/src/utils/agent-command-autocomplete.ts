import {
  compareMatchScores,
  type MatchScore,
  scoreTextFields,
} from "@getpaseo/protocol/search/text-match";

type CommandAutocompleteSource = "provider" | "plugin" | "client";

interface CommandAutocompleteEntry {
  source: CommandAutocompleteSource;
  command: {
    name: string;
    aliases?: readonly string[];
    kind?: string;
  };
}

// The list renders reversed above the input with the first entry selected. Paseo's own actions
// run at once (`/exit` archives), so an empty query never selects one: they sort farthest from
// the input, and with nothing else to list the menu waits for a search.
const EMPTY_QUERY_SOURCE_ORDER: Record<CommandAutocompleteSource, number> = {
  provider: 0,
  plugin: 1,
  client: 2,
};

export type SlashCommandPosition = "start" | "inline";

export interface SlashCommandRange {
  start: number;
  end: number;
  query: string;
  position: SlashCommandPosition;
}

interface FindActiveSlashCommandInput {
  text: string;
  cursorIndex: number;
}

interface ApplySlashCommandReplacementInput {
  text: string;
  command: SlashCommandRange;
  commandName: string;
}

interface ScoredCommandAutocompleteEntry<TEntry> {
  entry: TEntry;
  score: MatchScore;
}

function scoreCommandAutocompleteEntry(
  entry: CommandAutocompleteEntry,
  query: string,
): MatchScore | null {
  return scoreTextFields(query, [entry.command.name, ...(entry.command.aliases ?? [])]);
}

export function filterAndRankCommandAutocompleteEntries<TEntry extends CommandAutocompleteEntry>(
  entries: readonly TEntry[],
  query: string,
): TEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    if (entries.every((entry) => entry.source === "client")) return [];
    // Hermes has no `toSorted`.
    return [...entries].sort(
      (a, b) => EMPTY_QUERY_SOURCE_ORDER[a.source] - EMPTY_QUERY_SOURCE_ORDER[b.source],
    );
  }

  const scoredEntries: ScoredCommandAutocompleteEntry<TEntry>[] = [];
  for (const entry of entries) {
    const score = scoreCommandAutocompleteEntry(entry, normalizedQuery);
    if (score) {
      scoredEntries.push({ entry, score });
    }
  }

  scoredEntries.sort((a, b) => {
    const scoreComparison = compareMatchScores(a.score, b.score);
    if (scoreComparison !== 0) {
      return scoreComparison;
    }
    return a.entry.command.name.localeCompare(b.entry.command.name);
  });

  return scoredEntries.map((scored) => scored.entry);
}

export function filterInlineSkillCommandEntries<TEntry extends CommandAutocompleteEntry>(
  entries: readonly TEntry[],
): TEntry[] {
  return entries.filter((entry) => entry.source === "provider" && entry.command.kind === "skill");
}

const INVALID_SLASH_COMMAND_QUERY_CHARS = /[/\s\n\r\t"']/;

export function findActiveSlashCommand(
  input: FindActiveSlashCommandInput,
): SlashCommandRange | null {
  const clampedCursor = Math.max(0, Math.min(input.cursorIndex, input.text.length));
  const beforeCursor = input.text.slice(0, clampedCursor);

  for (
    let slashIndex = beforeCursor.lastIndexOf("/");
    slashIndex >= 0;
    slashIndex = slashIndex === 0 ? -1 : beforeCursor.lastIndexOf("/", slashIndex - 1)
  ) {
    const previousCharacter = slashIndex > 0 ? input.text[slashIndex - 1] : "";
    if (previousCharacter && !/\s/.test(previousCharacter)) {
      continue;
    }

    const query = beforeCursor.slice(slashIndex + 1);
    if (INVALID_SLASH_COMMAND_QUERY_CHARS.test(query)) {
      continue;
    }

    return {
      start: slashIndex,
      end: clampedCursor,
      query,
      position: slashIndex === 0 ? "start" : "inline",
    };
  }

  return null;
}

export function applySlashCommandReplacement(input: ApplySlashCommandReplacementInput): string {
  const before = input.text.slice(0, input.command.start);
  const after = input.text.slice(input.command.end);
  const replacement = `${before}/${input.commandName}${after}`;
  return input.command.end === input.text.length ? `${replacement} ` : replacement;
}
