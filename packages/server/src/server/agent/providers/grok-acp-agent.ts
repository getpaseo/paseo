import type { Logger } from "pino";

import type {
  AgentMode,
  AgentModelDefinition,
  AgentPersistenceHandle,
  AgentSelectOption,
  AgentSessionConfig,
} from "../agent-sdk-types.js";
import type { AvailableACPModel } from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";
import { createGrokContextUsageResolver, resolveGrokHome } from "./grok-context-usage.js";
import { deleteGrokNativeSession } from "./grok-delete-native-session.js";
import { normalizeGrokUserMessageText, transformGrokToolSnapshot } from "./grok-message-tags.js";

const GROK_CONTEXT_WINDOW_FALLBACKS: Record<string, number> = {
  "grok-4.5": 500_000,
};
const GROK_UNATTENDED_RULES =
  "Operate autonomously and complete the task without asking follow-up questions or requesting confirmation. Make reasonable assumptions, use tools as needed, and report decisions in the final response.";

export const GROK_ALWAYS_APPROVE_MODE_ID = "always-approve";
export const GROK_FULL_ACCESS_MODE_ID = "full-access";
export const GROK_PLAN_MODE_ID = "plan";

const GROK_MODES: AgentMode[] = [
  {
    id: "default",
    label: "Ask before tools",
    description: "Request approval before Grok runs tools.",
  },
  {
    id: GROK_ALWAYS_APPROVE_MODE_ID,
    label: "Always approve",
    description: "Allow Grok to run tools without approval prompts.",
    isUnattended: true,
  },
  {
    id: GROK_PLAN_MODE_ID,
    label: "Plan",
    description: "Inspect the workspace and prepare a plan before making changes.",
  },
  {
    id: GROK_FULL_ACCESS_MODE_ID,
    label: "Full access",
    description: "Run without approval prompts using Grok's host-wide devbox sandbox.",
    isUnattended: true,
  },
];

interface GrokACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function deriveGrokThinkingOptions(metadata: Record<string, unknown>): AgentSelectOption[] {
  const defaultId = readNonEmptyString(metadata.reasoningEffort);
  const efforts = Array.isArray(metadata.reasoningEfforts) ? metadata.reasoningEfforts : [];
  return efforts.flatMap((effort) => {
    if (!isRecord(effort)) return [];
    const id = readNonEmptyString(effort.id) ?? readNonEmptyString(effort.value);
    const label = readNonEmptyString(effort.label);
    if (!id || !label) return [];
    return [
      {
        id,
        label,
        description: readNonEmptyString(effort.description),
        isDefault: id === defaultId,
      },
    ];
  });
}

export function transformGrokModelDefinition(
  model: AvailableACPModel,
  definition: AgentModelDefinition,
): AgentModelDefinition {
  const metadata = isRecord(model._meta) ? model._meta : null;
  const contextWindowMaxTokens =
    (metadata ? readPositiveNumber(metadata.totalContextTokens) : undefined) ??
    GROK_CONTEXT_WINDOW_FALLBACKS[model.modelId];
  if (!metadata) {
    return contextWindowMaxTokens ? { ...definition, contextWindowMaxTokens } : definition;
  }

  const thinkingOptions = deriveGrokThinkingOptions(metadata);
  const defaultThinkingOptionId = thinkingOptions.find((option) => option.isDefault)?.id;
  return {
    ...definition,
    contextWindowMaxTokens,
    thinkingOptions: thinkingOptions.length > 0 ? thinkingOptions : definition.thinkingOptions,
    defaultThinkingOptionId: defaultThinkingOptionId ?? definition.defaultThinkingOptionId,
  };
}

export function buildGrokSessionLaunchArgs(config: AgentSessionConfig): string[] {
  const isUnattended =
    config.modeId === GROK_ALWAYS_APPROVE_MODE_ID || config.modeId === GROK_FULL_ACCESS_MODE_ID;
  return [
    ...(config.model ? ["--model", config.model] : []),
    ...(config.thinkingOptionId ? ["--reasoning-effort", config.thinkingOptionId] : []),
    ...(config.modeId === GROK_FULL_ACCESS_MODE_ID ? ["--sandbox", "devbox"] : []),
    ...(config.modeId === GROK_PLAN_MODE_ID ? ["--permission-mode", "plan"] : []),
    ...(isUnattended
      ? ["--permission-mode", "bypassPermissions", "--rules", GROK_UNATTENDED_RULES]
      : []),
  ];
}

export class GrokACPAgentClient extends GenericACPAgentClient {
  private readonly grokHome: string;

  constructor(options: GrokACPAgentClientOptions) {
    const grokHome = resolveGrokHome(options.env);
    super({
      ...options,
      defaultModes: GROK_MODES,
      modelDefinitionTransformer: transformGrokModelDefinition,
      contextUsageResolver: createGrokContextUsageResolver({ env: options.env }),
      sessionLaunchArgs: buildGrokSessionLaunchArgs,
      sessionLaunchArgsPlacement: "before-default-args",
      autoApprovePermissionModes: [GROK_ALWAYS_APPROVE_MODE_ID, GROK_FULL_ACCESS_MODE_ID],
      launchOnlyConfig: {
        mode: true,
        model: true,
        thinkingOption: true,
      },
      persistenceMetadata: () => ({ grokHome }),
      userMessageTextTransformer: normalizeGrokUserMessageText,
      toolSnapshotTransformer: transformGrokToolSnapshot,
    });
    this.grokHome = grokHome;
  }

  protected override async deleteLocalNativeSession(handle: AgentPersistenceHandle): Promise<void> {
    const metadata = (handle.metadata ?? {}) as { cwd?: string; grokHome?: string };
    await deleteGrokNativeSession({
      grokHome: typeof metadata.grokHome === "string" ? metadata.grokHome : this.grokHome,
      cwd: metadata.cwd,
      sessionId: handle.sessionId,
    });
  }
}
