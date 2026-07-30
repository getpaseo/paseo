import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";

export interface MetadataCustomEndpointDraft {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type MetadataModelDiscoveryStatus = "idle" | "loading" | "success" | "error";

export function getMetadataCustomEndpointCardState(input: {
  isConnected: boolean;
  config: MutableDaemonConfig | null;
  featureEnabled: boolean;
}): { isVisible: boolean } {
  return {
    isVisible: input.isConnected && input.featureEnabled,
  };
}

export function readMetadataCustomEndpointFromConfig(
  config: MutableDaemonConfig | null,
): MetadataCustomEndpointDraft {
  const customEndpoint = config?.metadataGeneration?.customEndpoint;
  return {
    enabled: customEndpoint?.enabled === true,
    baseUrl: typeof customEndpoint?.baseUrl === "string" ? customEndpoint.baseUrl : "",
    apiKey: typeof customEndpoint?.apiKey === "string" ? customEndpoint.apiKey : "",
    model: typeof customEndpoint?.model === "string" ? customEndpoint.model : "",
  };
}

export function createMetadataCustomEndpointPatch(
  input: MetadataCustomEndpointDraft,
): MutableDaemonConfigPatch {
  return {
    metadataGeneration: {
      customEndpoint: {
        enabled: input.enabled,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        model: input.model,
      },
    },
  };
}

export function shouldShowModelSuggestions(input: {
  discoveryStatus: MetadataModelDiscoveryStatus;
  models: Array<{ id: string }>;
}): boolean {
  return input.discoveryStatus === "success" && input.models.length > 0;
}

export function areMetadataCustomEndpointDraftsEqual(
  left: MetadataCustomEndpointDraft,
  right: MetadataCustomEndpointDraft,
): boolean {
  return (
    left.enabled === right.enabled &&
    left.baseUrl === right.baseUrl &&
    left.apiKey === right.apiKey &&
    left.model === right.model
  );
}

/**
 * AdaptiveTextInput ignores controlled `value` and only seeds via
 * `initialValue` + remount `resetKey`. Key off the persisted snapshot so
 * fields remount after save/config reload without wiping in-progress edits.
 */
export function buildMetadataCustomEndpointFieldResetKey(
  input: MetadataCustomEndpointDraft,
): string {
  return JSON.stringify([input.enabled, input.baseUrl, input.apiKey, input.model]);
}
