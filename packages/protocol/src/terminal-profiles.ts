import type { TerminalProfile } from "./messages.js";
import { KNOWN_PROVIDER_ICON_NAMES } from "./provider-icon-names.js";

export const DEFAULT_TERMINAL_PROFILES: readonly TerminalProfile[] = [
  { id: "claude", name: "Claude Code", command: "claude", icon: "claude" },
  { id: "codex", name: "Codex", command: "codex", icon: "codex" },
  { id: "opencode", name: "OpenCode", command: "opencode", icon: "opencode" },
];

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

export function resolveTerminalProfiles(
  terminalProfiles: TerminalProfile[] | undefined,
): readonly TerminalProfile[] {
  if (terminalProfiles === undefined) {
    return DEFAULT_TERMINAL_PROFILES;
  }
  return terminalProfiles;
}
