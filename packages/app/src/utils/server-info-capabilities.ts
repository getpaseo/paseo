import type { ServerCapabilityState } from "@getpaseo/protocol/messages";
import type { DaemonServerInfo } from "@/stores/session-store";

export type VoiceReadinessMode = "dictation" | "voice";

export function getServerCapabilities(params: {
  serverInfo: DaemonServerInfo | null | undefined;
}): DaemonServerInfo["capabilities"] | null {
  const capabilities = params.serverInfo?.capabilities;
  if (!capabilities) {
    return null;
  }
  return capabilities;
}

export function getVoiceReadinessState(params: {
  serverInfo: DaemonServerInfo | null | undefined;
  mode: VoiceReadinessMode;
}): ServerCapabilityState | null {
  const capabilities = getServerCapabilities({ serverInfo: params.serverInfo });
  const voice = capabilities?.voice;
  if (!voice) {
    return null;
  }
  if (params.mode === "dictation") {
    return voice.dictation;
  }
  return voice.voice;
}

/**
 * Whether a voice feature is enabled on the host.
 * Returns `null` when capability metadata is absent (legacy daemon — keep UI).
 */
export function isVoiceFeatureEnabled(params: {
  serverInfo: DaemonServerInfo | null | undefined;
  mode: VoiceReadinessMode;
}): boolean | null {
  const readiness = getVoiceReadinessState(params);
  if (!readiness) {
    return null;
  }
  return readiness.enabled;
}

export function resolveVoiceUnavailableMessage(params: {
  serverInfo: DaemonServerInfo | null | undefined;
  mode: VoiceReadinessMode;
}): string | null {
  const readiness = getVoiceReadinessState({
    serverInfo: params.serverInfo,
    mode: params.mode,
  });
  if (!readiness) {
    return null;
  }
  if (readiness.enabled && readiness.reason.trim().length === 0) {
    return null;
  }
  const message = readiness.reason.trim();
  if (message.length > 0) {
    return message;
  }
  return null;
}
