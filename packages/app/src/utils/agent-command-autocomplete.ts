import {
  DEFAULT_COMMAND_SIGIL,
  type ComposerSigil,
  type ComposerSigils,
} from "@/composer/tokens/sigils";
import {
  compareMatchScores,
  type MatchScore,
  scoreTextFields,
} from "@getpaseo/protocol/search/text-match";

interface CommandAutocompleteEntry {
  command: {
    name: string;
    aliases?: readonly string[];
    kind?: string;
  };
}

interface InlineSkillCommandEntry extends CommandAutocompleteEntry {
  source: "provider" | "client";
}

export type SlashCommandPosition = "start" | "inline";

/**
 * Which menu the trigger opens. `command` is the full slash-command list;
 * `skill` is the skills-only list opened by the dedicated skill sigil.
 */
export type SlashCommandMenu = "command" | "skill";

export interface SlashCommandRange {
  start: number;
  end: number;
  query: string;
  position: SlashCommandPosition;
  menu: SlashCommandMenu;
  /** The configured sigil that opened this trigger. */
  sigil: ComposerSigil;
}

interface FindActiveSlashCommandInput {
  text: string;
  cursorIndex: number;
  sigils: ComposerSigils;
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
    return [...entries];
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

export function filterInlineSkillCommandEntries<TEntry extends InlineSkillCommandEntry>(
  entries: readonly TEntry[],
): TEntry[] {
  return entries.filter((entry) => entry.source === "provider" && entry.command.kind === "skill");
}

const INVALID_QUERY_CHARS = /[/\s\n\r\t"']/;
const SHELL_VARIABLE_QUERY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isInvalidQuery(query: string, sigils: ComposerSigils): boolean {
  // A second sigil inside the query means the earlier one was not the live
  // trigger — the nearer sigil owns the cursor.
  return (
    INVALID_QUERY_CHARS.test(query) ||
    query.includes(sigils.command) ||
    query.includes(sigils.skill)
  );
}

/**
 * Find the trigger the cursor currently sits inside, scanning backwards so the
 * sigil nearest the cursor wins.
 */
export function findActiveSlashCommand(
  input: FindActiveSlashCommandInput,
): SlashCommandRange | null {
  const clampedCursor = Math.max(0, Math.min(input.cursorIndex, input.text.length));
  const beforeCursor = input.text.slice(0, clampedCursor);
  const { sigils } = input;

  for (let index = clampedCursor - 1; index >= 0; index -= 1) {
    const character = beforeCursor[index];
    const isCommandSigil = character === sigils.command;
    const isSkillSigil = character === sigils.skill;
    if (!isCommandSigil && !isSkillSigil) {
      continue;
    }

    const previousCharacter = index > 0 ? input.text[index - 1] : "";
    if (previousCharacter && !/\s/.test(previousCharacter)) {
      continue;
    }

    const query = beforeCursor.slice(index + 1);
    if (isInvalidQuery(query, sigils)) {
      continue;
    }

    return {
      start: index,
      end: clampedCursor,
      query,
      position: index === 0 ? "start" : "inline",
      menu: isSkillSigil ? "skill" : "command",
      sigil: character,
    };
  }

  return null;
}

export function applySlashCommandReplacement(input: ApplySlashCommandReplacementInput): string {
  const before = input.text.slice(0, input.command.start);
  const after = input.text.slice(input.command.end);
  const replacement = `${before}${DEFAULT_COMMAND_SIGIL}${input.commandName}${after}`;
  return input.command.end === input.text.length ? `${replacement} ` : replacement;
}

/**
 * `$name` is shell-variable shaped because of the `$` character, not because of
 * which menu it happens to open. The check keys off the sigil and deliberately
 * ignores `command.menu`: if the user assigns `$` to the command trigger,
 * `check $HOME` must still submit verbatim rather than being rewritten to
 * `check /HOME`. Tab and click remain the explicit commit actions in both
 * assignments.
 */
export function shouldSubmitShellVariable(input: {
  key: string;
  command: SlashCommandRange | null;
}): boolean {
  return (
    input.key === "Enter" &&
    input.command?.sigil === "$" &&
    SHELL_VARIABLE_QUERY.test(input.command.query)
  );
}
