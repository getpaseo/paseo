import type { AgentFeature } from "@getpaseo/protocol/agent-types";
import type { WorkspaceDraftTabSetup } from "@/workspace-tabs/model";

export interface ForkAgentSetupSource {
  provider?: string;
  accountProfileId?: string | null;
  cwd: string;
  currentModeId?: string | null;
  model?: string | null;
  thinkingOptionId?: string | null;
  runtimeInfo?: {
    model?: string | null;
    modeId?: string | null;
    thinkingOptionId?: string | null;
  } | null;
  features?: readonly AgentFeature[];
}

export type ForkAgentSetupOverrides = Partial<
  Pick<
    WorkspaceDraftTabSetup,
    "provider" | "accountProfileId" | "model" | "modeId" | "thinkingOptionId"
  >
>;

export function buildForkDraftSetup(
  agent: ForkAgentSetupSource,
  overrides: ForkAgentSetupOverrides | undefined = undefined,
): WorkspaceDraftTabSetup | undefined {
  if (!agent.provider) return undefined;
  const featureValues: Record<string, unknown> = {};
  for (const feature of agent.features ?? []) featureValues[feature.id] = feature.value;
  return {
    provider: agent.provider,
    accountProfileId: agent.accountProfileId,
    cwd: agent.cwd,
    modeId: agent.currentModeId ?? agent.runtimeInfo?.modeId ?? null,
    model: agent.model ?? agent.runtimeInfo?.model ?? null,
    thinkingOptionId: agent.thinkingOptionId ?? agent.runtimeInfo?.thinkingOptionId ?? null,
    featureValues,
    ...overrides,
  };
}
