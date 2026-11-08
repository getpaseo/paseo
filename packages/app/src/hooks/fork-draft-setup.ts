import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import type { WorkspaceDraftTabSetup } from "@/workspace-tabs/model";

/**
 * The subset of an agent record that a fork needs in order to seed the new
 * draft. Kept structural so both `AgentScreenAgent` (the agent-stream view's
 * live context) and the session store's `Agent` record satisfy it without a
 * projection step.
 */
export type ForkAgentSource = Pick<
  AgentScreenAgent,
  | "provider"
  | "cwd"
  | "currentModeId"
  | "model"
  | "thinkingOptionId"
  | "runtimeInfo"
  | "features"
  | "projectPlacement"
>;

/**
 * A stored agent whose provider was disabled or uninstalled can no longer be
 * loaded, so its timeline — and therefore its fork context — is unreachable.
 * The fork itself is still useful on a working provider, so it continues with a
 * placeholder instead of the transcript.
 */
const UNAVAILABLE_PROVIDER_ERROR_PATTERN =
  /references unavailable provider|Provider '[^']*' is (?:not available|disabled)/i;

export function isUnavailableProviderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return UNAVAILABLE_PROVIDER_ERROR_PATTERN.test(message);
}

const UNAVAILABLE_PROVIDER_FORK_TEXT = [
  "<chat-history-summary>",
  "Chat history from a previous Paseo agent.",
  "",
  "No chat history to display. The source agent's provider was unavailable, so",
  "its transcript could not be read.",
  "</chat-history-summary>",
].join("\n");

/**
 * Fork-context payload stand-in used when the source agent cannot be loaded.
 * Mirrors the daemon's empty-timeline payload so the draft still carries a chat
 * history attachment and tells the new agent why the transcript is missing.
 */
export function buildUnavailableProviderForkContext(agentId: string): Awaited<
  ReturnType<DaemonClient["buildAgentForkContext"]>
> {
  return {
    requestId: "",
    agentId,
    attachment: {
      type: "text",
      mimeType: "text/plain",
      contextKind: "chat_history",
      title: "Chat history",
      text: UNAVAILABLE_PROVIDER_FORK_TEXT,
    },
    itemCount: 0,
    boundaryCursor: null,
    boundaryMessageId: null,
    error: null,
  };
}

/**
 * Providers a new draft may actually start on, in provider-menu order. A fork
 * whose source provider was disabled (or uninstalled) has to fall back, because
 * the draft would otherwise inherit a provider that cannot run.
 */
export async function resolveSelectableProviders(
  client: DaemonClient,
  cwd: string,
): Promise<readonly AgentProvider[] | null> {
  try {
    const snapshot = await client.getProvidersSnapshot(cwd ? { cwd } : undefined);
    return snapshot.entries
      .filter((entry) => entry.enabled && entry.status === "ready")
      .map((entry) => entry.provider);
  } catch {
    // Older hosts, or a disconnected snapshot, must not block forking.
    return null;
  }
}

export function buildForkDraftSetup(
  agent: ForkAgentSource,
  selectableProviders: readonly AgentProvider[] | null,
): WorkspaceDraftTabSetup | undefined {
  if (!agent.provider) {
    return undefined;
  }

  const keepSourceProvider =
    selectableProviders === null ||
    selectableProviders.length === 0 ||
    selectableProviders.includes(agent.provider);
  const provider = keepSourceProvider ? agent.provider : selectableProviders[0];
  if (!provider) {
    return undefined;
  }

  // Mode, model, thinking, and features are provider-specific: carrying them to
  // a different provider would seed values that provider cannot resolve.
  if (!keepSourceProvider) {
    return {
      provider,
      cwd: agent.cwd,
      modeId: null,
      model: null,
      thinkingOptionId: null,
      featureValues: {},
    };
  }

  const featureValues: Record<string, unknown> = {};
  for (const feature of agent.features ?? []) {
    featureValues[feature.id] = feature.value;
  }

  return {
    provider,
    cwd: agent.cwd,
    modeId: agent.currentModeId ?? agent.runtimeInfo?.modeId ?? null,
    model: agent.model ?? agent.runtimeInfo?.model ?? null,
    thinkingOptionId: agent.thinkingOptionId ?? agent.runtimeInfo?.thinkingOptionId ?? null,
    featureValues,
  };
}
