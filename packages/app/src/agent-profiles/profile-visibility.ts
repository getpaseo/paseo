import type { AgentProfile } from "@getpaseo/protocol/messages";

/** Workflow profiles stay in the host catalog for internal workflow roles. */
export function isWorkflowAgentProfile(profile: Pick<AgentProfile, "name">): boolean {
  return profile.name.startsWith("Workflow");
}

export function visibleAgentProfiles<T extends Pick<AgentProfile, "name">>(profiles: readonly T[]) {
  return profiles.filter((profile) => !isWorkflowAgentProfile(profile));
}
