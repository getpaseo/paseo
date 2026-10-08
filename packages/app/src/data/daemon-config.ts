import type { MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";

interface ScopeDaemonConfigPatchInput {
  patch: MutableDaemonConfigPatch;
  settingsProfileId?: string;
}

export function scopeDaemonConfigPatch({
  patch,
  settingsProfileId,
}: ScopeDaemonConfigPatchInput): MutableDaemonConfigPatch {
  if (!settingsProfileId || patch.agentSettingsProfiles || patch.agentSettingsProfilePatch)
    return patch;
  const { appendSystemPrompt, agentProfiles, mcp, browserTools, ...unscopedPatch } = patch;
  const scopedSettings = {
    ...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
    ...(agentProfiles !== undefined ? { agentProfiles } : {}),
    ...(mcp?.injectIntoAgents !== undefined
      ? { mcp: { injectIntoAgents: mcp.injectIntoAgents } }
      : {}),
    ...(browserTools?.enabled !== undefined
      ? { browserTools: { enabled: browserTools.enabled } }
      : {}),
  };
  if (Object.keys(scopedSettings).length === 0) return patch;
  return {
    ...unscopedPatch,
    agentSettingsProfilePatch: { profileId: settingsProfileId, ...scopedSettings },
  };
}

export function daemonConfigQueryKey(serverId: string | null) {
  return ["daemon-config", serverId] as const;
}
