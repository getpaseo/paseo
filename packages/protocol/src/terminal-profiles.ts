import type { TerminalProfile } from "./messages.js";
import { KNOWN_PROVIDER_ICON_NAMES } from "./provider-icon-names.js";

/**
 * Marks where a typed prompt goes inside a profile's `command` or `args`. A
 * profile carrying it accepts a prompt; one without it launches as-is.
 *
 * Substitution happens client-side before `create_terminal_request` is sent, so
 * this is profile-format vocabulary rather than anything on the wire. It lives
 * here because this module owns what a `TerminalProfile` means.
 */
export const PROMPT_SENTINEL = "{{{prompt}}}";

// Prompt forms are taken from each CLI's own `--help`. claude, codex, and pi
// take the prompt as a trailing positional. opencode's positional is the
// project directory, so its prompt goes through `--prompt`, written in the
// `--flag=value` form to keep it one argv entry that can be dropped whole when
// no prompt is typed.
export const DEFAULT_TERMINAL_PROFILES: readonly TerminalProfile[] = [
  { id: "claude", name: "Claude Code", command: "claude", args: [PROMPT_SENTINEL], icon: "claude" },
  { id: "codex", name: "Codex", command: "codex", args: [PROMPT_SENTINEL], icon: "codex" },
  {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    args: [`--prompt=${PROMPT_SENTINEL}`],
    icon: "opencode",
  },
  { id: "pi", name: "Pi", command: "pi", args: [PROMPT_SENTINEL], icon: "pi" },
];

export interface SubstitutableCommand {
  command: string;
  args?: string[];
}

export interface ResolvedCommand {
  command: string;
  args: string[];
}

function containsSentinel(value: string): boolean {
  return value.includes(PROMPT_SENTINEL);
}

/** True when the sentinel appears anywhere in `command` or an `args` entry. */
export function profileTakesPrompt(profile: SubstitutableCommand): boolean {
  return containsSentinel(profile.command) || (profile.args ?? []).some(containsSentinel);
}

function replaceSentinel(value: string, prompt: string): string {
  return value.split(PROMPT_SENTINEL).join(prompt);
}

/**
 * An arg that exists only to carry a prompt: the sentinel alone
 * (`{{{prompt}}}`), or as the whole value of an option assignment
 * (`--prompt={{{prompt}}}`). Both are dropped when there is no prompt, because
 * an empty positional and a valueless `--prompt=` are not the same as omitting
 * them. A sentinel embedded in larger text (`echo {{{prompt}}}`) is not
 * prompt-only and still substitutes to empty.
 *
 * This is why an option and its value belong in one entry. Split across two,
 * the option would survive with nothing to carry.
 */
function isPromptOnlyArg(arg: string): boolean {
  if (arg === PROMPT_SENTINEL) {
    return true;
  }
  const separator = arg.indexOf("=");
  return separator > 0 && arg.slice(separator + 1) === PROMPT_SENTINEL;
}

/** Replaces every sentinel occurrence with `prompt`, dropping prompt-only args when there is none. */
export function substitutePrompt(profile: SubstitutableCommand, prompt: string): ResolvedCommand {
  return {
    command: replaceSentinel(profile.command, prompt),
    args: (profile.args ?? []).flatMap((arg) =>
      prompt === "" && isPromptOnlyArg(arg) ? [] : [replaceSentinel(arg, prompt)],
    ),
  };
}

/** Human-readable preview of the resolved command, for read-only display. */
export function formatResolvedCommand(resolved: ResolvedCommand): string {
  return [resolved.command, ...resolved.args].join(" ");
}

export interface TerminalProfileLaunch {
  name: string;
  command: string;
  args: string[];
}

/**
 * What to spawn for a profile. Every launcher goes through here, so no caller
 * can forward a raw `profile.args` still carrying the sentinel: launchers with
 * nowhere to type (pinned targets, the workspace terminal menu) pass an empty
 * prompt and get the bare command back.
 */
export function resolveTerminalProfileLaunch(
  profile: TerminalProfile,
  prompt: string,
): TerminalProfileLaunch {
  return { name: profile.name, ...substitutePrompt(profile, prompt) };
}

const WELL_KNOWN_COMMAND_ICONS = new Map(KNOWN_PROVIDER_ICON_NAMES.map((name) => [name, name]));

function getCommandBaseName(command: string): string {
  const lastSlash = command.lastIndexOf("/");
  const lastBackslash = command.lastIndexOf("\\");
  const start = Math.max(lastSlash, lastBackslash) + 1;
  const base = command.slice(start).toLowerCase();
  const dotIndex = base.indexOf(".");
  return dotIndex > 0 ? base.slice(0, dotIndex) : base;
}

export function guessTerminalProfileIcon(command: string): string | undefined {
  return WELL_KNOWN_COMMAND_ICONS.get(getCommandBaseName(command));
}

export function getTerminalProfileIcon(profile: TerminalProfile): string | undefined {
  return profile.icon ?? guessTerminalProfileIcon(profile.command);
}

// Base command name to the sentinel-bearing args that command wants, derived
// from the shipped defaults rather than written out again, so adding a default
// profile later cannot silently miss the adoption below or get the wrong form.
const PROMPT_ARGS_BY_COMMAND = new Map(
  DEFAULT_TERMINAL_PROFILES.map((profile) => [
    getCommandBaseName(profile.command),
    (profile.args ?? []).filter(containsSentinel),
  ]),
);

// Profiles predating the sentinel got materialized into user config the first
// time anyone touched the profile list (host-page.tsx patches the whole list on
// any add, edit, or reorder). Those users would otherwise be stuck with
// launch-only versions of the agents we ship, while a fresh install gets prompt
// support, so a profile still pointing at one of those agents adopts the
// trailing sentinel on read.
//
// Keyed on the command's base name, not the profile id: profiles created
// through the settings UI get generated ids (`profile_<timestamp>_<random>`),
// so a real user's Codex profile is never id `codex`. The base name also
// normalizes `/usr/local/bin/codex` and `codex.cmd` onto the same agent.
//
// User args are preserved: `codex --yolo` becomes `codex --yolo {{{prompt}}}`.
// The appended form comes from the shipped default for that command, so
// opencode gets `--prompt=` rather than a trailing positional, which it would
// read as a project directory. A profile that already carries the sentinel
// anywhere is left alone, and so is one pointing at any other command. Nothing
// is written back, so this stays a read-time adoption with no version stamp and
// no daemon-start hook.
// A leading bare word is a subcommand, and a subcommand means the profile is
// not the interactive launch we ship a prompt form for: `opencode run` takes a
// positional message rather than `--prompt`, and `codex login` takes no prompt
// at all. Only the first arg is checked, because these CLIs all take the
// subcommand first; a bare word later is a flag's value, as in
// `pi --thinking high`.
function hasSubcommand(args: readonly string[]): boolean {
  const first = args[0];
  return first !== undefined && !first.startsWith("-");
}

function adoptPromptSentinel(profile: TerminalProfile): TerminalProfile {
  const promptArgs = PROMPT_ARGS_BY_COMMAND.get(getCommandBaseName(profile.command));
  if (!promptArgs || promptArgs.length === 0) {
    return profile;
  }
  const args = profile.args ?? [];
  if (profileTakesPrompt(profile) || hasSubcommand(args)) {
    return profile;
  }
  return { ...profile, args: [...args, ...promptArgs] };
}

export function resolveTerminalProfiles(
  terminalProfiles: TerminalProfile[] | undefined,
): readonly TerminalProfile[] {
  if (terminalProfiles === undefined) {
    return DEFAULT_TERMINAL_PROFILES;
  }
  return terminalProfiles.map(adoptPromptSentinel);
}
