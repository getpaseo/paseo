import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import {
  resolveTerminalProfiles,
  substitutePrompt,
  type ResolvedCommand,
} from "@getpaseo/protocol/terminal-profiles";

export type DefaultTerminalProfileConfig = Pick<
  MutableDaemonConfig,
  "defaultTerminalProfileId" | "terminalProfiles"
>;

/**
 * What a plain new terminal launches: the host's default profile, or undefined
 * when no default is set or the id no longer names a profile, so the spawn
 * falls back to the system shell.
 *
 * The list goes through resolveTerminalProfiles so a default pointing at a
 * shipped profile still resolves when the user has never edited the list, and
 * one predating the prompt sentinel gets the same adoption an explicit launch
 * gets. The prompt is empty because nothing is typed on this path, which drops
 * the prompt-only args exactly as a client-side profile launch does.
 */
export function resolveDefaultTerminalLaunch(
  config: DefaultTerminalProfileConfig,
): ResolvedCommand | undefined {
  const profileId = config.defaultTerminalProfileId;
  if (!profileId) {
    return undefined;
  }

  const profile = resolveTerminalProfiles(config.terminalProfiles).find(
    (candidate) => candidate.id === profileId,
  );
  return profile ? substitutePrompt(profile, "") : undefined;
}
