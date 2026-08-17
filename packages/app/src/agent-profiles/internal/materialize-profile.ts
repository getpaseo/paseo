import type { AgentConfigApply, AgentProfile } from "@getpaseo/protocol/messages";

/**
 * A profile with its blank fields resolved away. Storage keeps every field
 * optional and lets the user clear one to an empty string; applying has to know
 * the difference between "set this" and "leave whatever is there alone", and
 * every consumer would otherwise re-derive the same trim-and-drop rules.
 */
export interface MaterializedAgentProfile {
  provider: string;
  /** Empty when the profile names no model, meaning "leave the model alone". */
  modelId: string;
  modeId: string;
  thinkingOptionId: string;
  featureValues: Record<string, unknown>;
}

function trimmed(value: string | undefined): string {
  return value?.trim() ?? "";
}

export function materializeAgentProfile(profile: AgentProfile): MaterializedAgentProfile {
  return {
    provider: trimmed(profile.provider),
    modelId: trimmed(profile.model),
    modeId: trimmed(profile.modeId),
    thinkingOptionId: trimmed(profile.thinkingOptionId),
    featureValues: profile.featureValues ?? {},
  };
}

export function reconcileMaterializedProfileMode(
  profile: MaterializedAgentProfile,
  availableModeIds: readonly string[] | null,
): MaterializedAgentProfile | null {
  if (availableModeIds === null) {
    return null;
  }
  if (!profile.modeId || availableModeIds.includes(profile.modeId)) {
    return profile;
  }
  return { ...profile, modeId: "" };
}

/**
 * The payload for a running agent. Omitted fields are left alone by the daemon,
 * so a profile that names no mode does not reset the agent's mode. Provider is
 * absent because a running agent cannot change the process it is.
 */
export function toAgentConfigApply(profile: MaterializedAgentProfile): AgentConfigApply {
  return {
    ...(profile.modelId ? { modelId: profile.modelId } : {}),
    ...(profile.modeId ? { modeId: profile.modeId } : {}),
    ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
    ...(Object.keys(profile.featureValues).length > 0
      ? { featureValues: profile.featureValues }
      : {}),
  };
}
