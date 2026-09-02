import type { MaterializedAgentProfile } from "./materialize-profile";

export interface RunningProfileTarget {
  provider: string;
  accountProfileId: string | null | undefined;
}

export function requiresProfileContinuation(
  profile: MaterializedAgentProfile,
  target: RunningProfileTarget,
): boolean {
  return (
    profile.provider !== target.provider ||
    (profile.accountProfileId !== undefined && profile.accountProfileId !== target.accountProfileId)
  );
}
