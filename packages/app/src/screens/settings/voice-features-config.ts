import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";

export type VoiceFeatureId = "dictation" | "voiceMode";

export interface VoiceFeatureRowState {
  id: VoiceFeatureId;
  isEnabled: boolean;
}

export interface VoiceFeaturesCardState {
  isVisible: boolean;
  rows: VoiceFeatureRowState[];
}

export interface VoiceFeaturesMutationViewState {
  isSwitchDisabled: boolean;
  loadingText: string | null;
  errorText: string | null;
}

function readFeatureEnabled(config: MutableDaemonConfig | null, feature: VoiceFeatureId): boolean {
  const entry = config?.[feature];
  // Opt-in: unknown/missing config must not look enabled (avoids load-then-hide flash).
  return entry?.enabled === true;
}

export function getVoiceFeaturesCardState(input: {
  isConnected: boolean;
  config: MutableDaemonConfig | null;
}): VoiceFeaturesCardState {
  return {
    isVisible: input.isConnected,
    rows: [
      { id: "dictation", isEnabled: readFeatureEnabled(input.config, "dictation") },
      { id: "voiceMode", isEnabled: readFeatureEnabled(input.config, "voiceMode") },
    ],
  };
}

export function createVoiceFeaturePatch(
  feature: VoiceFeatureId,
  enabled: boolean,
): MutableDaemonConfigPatch {
  return { [feature]: { enabled } };
}

export function getVoiceFeaturesMutationViewState(input: {
  isPending: boolean;
  error: unknown;
  updatingLabel: string;
}): VoiceFeaturesMutationViewState {
  return {
    isSwitchDisabled: input.isPending,
    loadingText: input.isPending ? input.updatingLabel : null,
    errorText: input.error ? toErrorMessage(input.error) : null,
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
