import type { TerminalProfile } from "@getpaseo/protocol/messages";
import type { LaunchTarget } from "@/create-agent-preferences/preferences";

export type { LaunchTarget };

// A blank terminal isn't a configured TerminalProfile, it's "no command", i.e.
// the daemon's default shell. It still needs a stable id to round-trip through
// FormPreferences (`launchTarget.profileId` is a required string) and to sit
// alongside real profiles in the picker.
export const BLANK_TERMINAL_PROFILE_ID = "blank";

export const CHAT_LAUNCH_TARGET: LaunchTarget = { kind: "chat" };

export function isBlankTerminalTarget(target: LaunchTarget): boolean {
  return target.kind === "terminal" && target.profileId === BLANK_TERMINAL_PROFILE_ID;
}

export function terminalLaunchTarget(profileId: string): LaunchTarget {
  return { kind: "terminal", profileId };
}

/** The selected profile for a terminal target, or null for Chat and blank terminals. */
export function resolveLaunchProfile(
  target: LaunchTarget,
  profiles: readonly TerminalProfile[],
): TerminalProfile | null {
  if (target.kind !== "terminal" || isBlankTerminalTarget(target)) {
    return null;
  }
  return profiles.find((profile) => profile.id === target.profileId) ?? null;
}

/**
 * Resolves a target against the currently available profiles, falling back to
 * Chat when it names a profile that no longer exists (removed since it was
 * picked or persisted).
 */
export function resolveLaunchTarget(
  target: LaunchTarget | undefined,
  profiles: readonly TerminalProfile[],
): LaunchTarget {
  if (!target || target.kind === "chat") {
    return CHAT_LAUNCH_TARGET;
  }
  if (isBlankTerminalTarget(target)) {
    return target;
  }
  return resolveLaunchProfile(target, profiles) ? target : CHAT_LAUNCH_TARGET;
}
