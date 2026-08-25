import type { AgentInfo, ModelInfo } from "@opencode-ai/client";

import type { AgentMode, AgentModelDefinition, AgentSelectOption } from "../../agent-sdk-types.js";
import {
  createProviderEnvSpec,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import { execCommand } from "../../../../utils/spawn.js";

const OPENCODE_V2_DEFAULT_VARIANT_ID = "default";
const OPENCODE_V2_FREE_PROVIDER_ID = "opencode";
const OPENCODE_V2_AUTH_LIST_TIMEOUT_MS = 5_000;

const OPENCODE_V2_DEFAULT_MODES: AgentMode[] = [
  {
    id: "build",
    label: "Build",
    description: "Allows edits and tool execution for implementation work",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Read-only planning mode that avoids file edits",
  },
];

/**
 * An agent is selectable as a mode unless it is hidden. v2 exposes internal
 * agents (compaction/title/summary) with `hidden: true`; everything else,
 * including subagent-mode agents like `general`, can be switched to via
 * `session.switchAgent`, so they stay listed.
 */
export function isSelectableOpenCodeV2Agent(agent: AgentInfo): boolean {
  return agent.hidden !== true;
}

export function mapOpenCodeV2AgentToMode(agent: AgentInfo): AgentMode {
  return {
    // v2 agent ids are capitalized (Build, Plan); normalize to lowercase so
    // mode ids match the manifest (build/plan) and the server accepts both.
    id: agent.name.toLowerCase(),
    label: agent.name.charAt(0).toUpperCase() + agent.name.slice(1),
    icon: "Bot",
    description:
      typeof agent.description === "string" && agent.description.trim().length > 0
        ? agent.description.trim()
        : undefined,
    ...(typeof agent.color === "string" && agent.color.length > 0
      ? { colorTier: agent.color }
      : {}),
  };
}

export function sortOpenCodeV2Modes(modes: AgentMode[]): AgentMode[] {
  const order = new Map(OPENCODE_V2_DEFAULT_MODES.map((mode, index) => [mode.id, index]));
  return [...modes].sort((left, right) => {
    const leftOrder = order.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.label.localeCompare(right.label);
  });
}

export function mapOpenCodeV2ModelToDefinition(model: ModelInfo): AgentModelDefinition {
  const variantIds = model.variants.map((variant) => variant.id);
  const thinkingOptions: AgentSelectOption[] = variantIds.length
    ? [
        { id: OPENCODE_V2_DEFAULT_VARIANT_ID, label: "Default", isDefault: true },
        ...variantIds.map((id) => ({ id, label: id })),
      ]
    : [];

  return {
    provider: "opencode-v2",
    id: `${model.providerID}/${model.modelID}`,
    label: model.name,
    description: model.family ? model.family : undefined,
    thinkingOptions: thinkingOptions.length > 0 ? thinkingOptions : undefined,
    defaultThinkingOptionId: thinkingOptions[0]?.id,
    contextWindowMaxTokens: model.limit?.context,
    metadata: {
      providerId: model.providerID,
      modelId: model.modelID,
      family: model.family,
      supportsAttachments: model.capabilities?.input?.includes("image") ?? false,
      supportsReasoning: model.compatibility?.reasoningField !== undefined,
      supportsToolCall: model.capabilities?.tools ?? false,
      cost: model.cost,
      contextWindowMaxTokens: model.limit?.context,
      limit: model.limit,
      status: model.status,
    },
  };
}

/**
 * Keep only models whose provider has stored credentials, plus the public/free
 * `opencode` provider that needs no credentials. The v2 `/api/model` endpoint
 * already filters to "available" providers, but the isolated server home can
 * carry seeded credentials that the user's real home does not; this filter
 * reconciles the catalog with the real auth state so no listed model fails at
 * prompt time.
 */
export function filterOpenCodeV2ModelInfosByCredentials(
  models: readonly ModelInfo[],
  credentialedProviderIds: ReadonlySet<string>,
): ModelInfo[] {
  return models.filter((model) => {
    if (model.providerID === OPENCODE_V2_FREE_PROVIDER_ID) {
      return true;
    }
    return credentialedProviderIds.has(model.providerID);
  });
}

/**
 * Resolve the set of provider ids that have stored credentials by running
 * `opencode2 auth list --format json` against the daemon's real environment
 * (the user's real opencode2 home). A failure resolves to an empty set so the
 * catalog falls back to only the public/free `opencode` models rather than
 * listing models that would fail auth at prompt time.
 */
export async function readOpenCodeV2CredentialedProviderIds(
  runtimeSettings?: ProviderRuntimeSettings,
): Promise<Set<string>> {
  try {
    const launch = await resolveProviderLaunch({
      commandConfig: runtimeSettings?.command,
      defaultBinary: "opencode2",
    });
    const { stdout } = await execCommand(
      launch.command,
      [...launch.args, "auth", "list", "--format", "json"],
      {
        ...createProviderEnvSpec({ runtimeSettings }),
        timeout: OPENCODE_V2_AUTH_LIST_TIMEOUT_MS,
      },
    );
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    const ids = new Set<string>();
    for (const entry of parsed) {
      const id = entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined;
      if (typeof id === "string" && id.trim().length > 0) {
        ids.add(id);
      }
    }
    return ids;
  } catch {
    return new Set();
  }
}
