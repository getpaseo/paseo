import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import type { ProviderUsage } from "../messages.js";
import type { ProviderUsageListResult } from "../../services/quota-fetcher/service.js";
import { parseChoiceAnswer, type TypeSafeChoiceQuestion } from "../browser-tools/jev-client.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { loadPersistedConfig } from "../persisted-config.js";
import { isSystemOneExcluded } from "./scope.js";
import { createConfiguredSystemOneDecisionSource } from "./tools.js";

const MAX_TASK_CHARS = 6_000;

/** Above this usage a provider counts as exhausted for new agents. */
export const CREATE_ROUTING_EXHAUSTED_PCT = 95;

export interface CreateRouteInput {
  requestedProvider: string;
  requestedModel: string | undefined;
  requestedThinking: string | undefined;
  prompt: AgentPromptInput | string;
  cwd: string;
  /** Only agent-spawned children are auto-routed; human session creates stay manual. */
  isAgentScoped: boolean;
}

export interface CreateRoute {
  provider: string;
  model?: string;
  thinkingOptionId?: string;
}

export type CreateRouter = (input: CreateRouteInput) => Promise<CreateRoute | null>;

export function providerMaxUsedPct(usage: ProviderUsage | undefined): number | null {
  if (!usage || usage.status !== "available") return null;
  let max: number | null = null;
  for (const window of usage.windows ?? []) {
    const pct = window.usedPct ?? null;
    if (typeof pct === "number" && Number.isFinite(pct)) {
      max = max === null ? pct : Math.max(max, pct);
    }
  }
  return max;
}

export function isProviderExhaustedForCreate(
  usage: ProviderUsage | undefined,
  thresholdPct: number = CREATE_ROUTING_EXHAUSTED_PCT,
): boolean {
  const max = providerMaxUsedPct(usage);
  return max !== null && max >= thresholdPct;
}

function promptText(prompt: AgentPromptInput | string): string {
  if (typeof prompt === "string") return prompt;
  return prompt
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

const COMPLEXITY_TEXT = {
  lowest: "trivial questions, lookups, status checks, small mechanical edits",
  middle: "routine implementation, known-cause fixes, straightforward tests",
  highest: "architecture, hard debugging, security, migrations, risky cross-file changes",
};

function complexityCriteria(): Record<string, string> {
  return {
    tier1: `Tier 1 of 3 (cheapest): ${COMPLEXITY_TEXT.lowest}`,
    tier2: `Tier 2 of 3: ${COMPLEXITY_TEXT.middle}`,
    tier3: `Tier 3 of 3 (strongest): ${COMPLEXITY_TEXT.highest}`,
  };
}

/**
 * Quota-aware provider/model selection for new agents.
 *
 * Only agent-scoped creates (Paseo subagents) are routed. Human session creates
 * keep their explicit provider/model. Fail-open with a cheap fallback: when Jev
 * or quota data is missing, cap to the cheapest rung instead of Opus/XHigh.
 */
export function createSystemOneCreateRouter(options: {
  paseoHome: string;
  daemonConfigStore: Pick<DaemonConfigStore, "get">;
  getUsage?: () => Promise<ProviderUsageListResult | null>;
}): CreateRouter {
  return async (input) => {
    const task = precheckCreateRoute(options, input);
    if (task === null) return null;

    const tierIndex = await decideComplexityTier({
      paseoHome: options.paseoHome,
      daemonConfigStore: options.daemonConfigStore,
      cwd: input.cwd,
      task,
      minimumConfidence: options.daemonConfigStore.get().systemOne?.minimumConfidence ?? 0.5,
    });

    const persistedRouting =
      loadPersistedConfig(options.paseoHome).daemon?.systemOne?.routing ?? {};
    const usageByProvider = await loadUsageByProvider(options.getUsage);
    return selectCreateRoute({ input, tierIndex, persistedRouting, usageByProvider });
  };
}

async function decideComplexityTier(params: {
  paseoHome: string;
  daemonConfigStore: Pick<DaemonConfigStore, "get">;
  cwd: string;
  task: string;
  minimumConfidence: number;
}): Promise<number> {
  try {
    const questions: Record<string, TypeSafeChoiceQuestion> = {
      complexity: {
        type: "choice",
        instructions:
          "Pick the least capable coding-agent tier that will still do this task well. Cheaper tiers save real money; only escalate when the task needs it.",
        criteria: complexityCriteria(),
      },
    };
    const decision = await createConfiguredSystemOneDecisionSource(
      params.paseoHome,
      params.daemonConfigStore,
      () => params.cwd,
    ).decide({ state: { task: params.task }, questions });
    const parsed = parseChoiceAnswer(decision.answers.complexity, ["tier1", "tier2", "tier3"]);
    if (parsed.confidence < params.minimumConfidence) return 0;
    return Math.max(0, ["tier1", "tier2", "tier3"].indexOf(parsed.choice));
  } catch {
    // Fail-open cheap: unknown complexity must never default to the top rung.
    return 0;
  }
}

function allowedLadderIndex(tierIndex: number, ladderLength: number): number {
  if (ladderLength <= 0) return 0;
  if (tierIndex <= 0) return 0;
  if (tierIndex === 1) return Math.min(1, ladderLength - 1);
  return ladderLength - 1;
}

function capToTier(params: {
  ladder: { models: string[]; thinking?: string[] };
  requestedModel: string | undefined;
  requestedThinking: string | undefined;
  allowedMaxIndex: number;
}): { model?: string; thinkingOptionId?: string } {
  const out: { model?: string; thinkingOptionId?: string } = {};
  const cappedModel =
    params.ladder.models[Math.min(params.allowedMaxIndex, params.ladder.models.length - 1)];
  if (params.requestedModel !== cappedModel) {
    // Only downgrade, never escalate a subagent beyond what was requested.
    const requestedIndex = params.requestedModel
      ? params.ladder.models.indexOf(params.requestedModel)
      : -1;
    if (requestedIndex === -1 || requestedIndex > params.allowedMaxIndex) {
      if (cappedModel) out.model = cappedModel;
    }
  }
  if (params.ladder.thinking) {
    const thinkingCap =
      params.ladder.thinking[Math.min(params.allowedMaxIndex, params.ladder.thinking.length - 1)];
    if (params.requestedThinking !== thinkingCap) {
      const requestedThinkingIndex = params.requestedThinking
        ? params.ladder.thinking.indexOf(params.requestedThinking)
        : -1;
      if (requestedThinkingIndex === -1 || requestedThinkingIndex > params.allowedMaxIndex) {
        if (thinkingCap) out.thinkingOptionId = thinkingCap;
      }
    }
  }
  return out;
}

function precheckCreateRoute(
  options: {
    paseoHome: string;
    daemonConfigStore: Pick<DaemonConfigStore, "get">;
  },
  input: CreateRouteInput,
): string | null {
  if (!input.isAgentScoped) return null;
  if (!options.daemonConfigStore.get().systemOne?.enabled) return null;
  if (isSystemOneExcluded(options.paseoHome, input.cwd)) return null;
  const task = promptText(input.prompt).slice(0, MAX_TASK_CHARS);
  if (task.trim().length === 0) return null;
  const persistedRouting = loadPersistedConfig(options.paseoHome).daemon?.systemOne?.routing ?? {};
  if (!persistedRouting[input.requestedProvider]) return null;
  return task;
}

async function loadUsageByProvider(
  getUsage: (() => Promise<ProviderUsageListResult | null>) | undefined,
): Promise<Map<string, ProviderUsage>> {
  try {
    const usage = await getUsage?.();
    const byProvider = new Map<string, ProviderUsage>();
    for (const entry of usage?.providers ?? []) {
      byProvider.set(entry.providerId, entry);
    }
    return byProvider;
  } catch {
    return new Map();
  }
}

function selectCreateRoute(params: {
  input: CreateRouteInput;
  tierIndex: number;
  persistedRouting: Record<string, { models: string[]; thinking?: string[] }>;
  usageByProvider: Map<string, ProviderUsage>;
}): CreateRoute | null {
  const requestedLadder = params.persistedRouting[params.input.requestedProvider];
  if (!requestedLadder) return null;
  const allowedMaxIndex = allowedLadderIndex(params.tierIndex, requestedLadder.models.length);
  const capped = capToTier({
    ladder: requestedLadder,
    requestedModel: params.input.requestedModel,
    requestedThinking: params.input.requestedThinking,
    allowedMaxIndex,
  });
  const unchanged =
    (capped.model === undefined || capped.model === params.input.requestedModel) &&
    (capped.thinkingOptionId === undefined ||
      capped.thinkingOptionId === params.input.requestedThinking);
  // Simple tasks stay on the requested provider, capped cheap. Only switch
  // providers when the requested one is exhausted and an alternative has room.
  if (!isProviderExhaustedForCreate(params.usageByProvider.get(params.input.requestedProvider))) {
    if (unchanged) return null;
    return { provider: params.input.requestedProvider, ...capped };
  }
  const alternative = pickAlternativeProvider({
    persistedRouting: params.persistedRouting,
    usageByProvider: params.usageByProvider,
    excludeProvider: params.input.requestedProvider,
    tierIndex: params.tierIndex,
  });
  // Exhausted with nowhere to go: stay cheap on the requested provider
  // rather than burning the top rung.
  if (!alternative) {
    if (unchanged) return null;
    return { provider: params.input.requestedProvider, ...capped };
  }
  return alternative;
}

function pickAlternativeProvider(params: {
  persistedRouting: Record<string, { models: string[]; thinking?: string[] }>;
  usageByProvider: Map<string, ProviderUsage>;
  excludeProvider: string;
  tierIndex: number;
}): CreateRoute | null {
  const candidates: Array<{ provider: string; usedPct: number; route: CreateRoute }> = [];
  for (const [provider, ladder] of Object.entries(params.persistedRouting)) {
    if (provider === params.excludeProvider) continue;
    const usage = params.usageByProvider.get(provider);
    if (isProviderExhaustedForCreate(usage)) continue;
    const allowedMaxIndex = allowedLadderIndex(params.tierIndex, ladder.models.length);
    const model = ladder.models[Math.min(allowedMaxIndex, ladder.models.length - 1)];
    if (!model) continue;
    const thinkingOptionId = ladder.thinking
      ? ladder.thinking[Math.min(allowedMaxIndex, ladder.thinking.length - 1)]
      : undefined;
    candidates.push({
      provider,
      usedPct: providerMaxUsedPct(usage) ?? 0,
      route: {
        provider,
        model,
        ...(thinkingOptionId ? { thinkingOptionId } : {}),
      },
    });
  }
  candidates.sort((a, b) => a.usedPct - b.usedPct);
  return candidates[0]?.route ?? null;
}
