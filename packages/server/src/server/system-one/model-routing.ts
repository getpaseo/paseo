import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import type { ProviderUsage } from "../messages.js";
import type { ProviderUsageListResult } from "../../services/quota-fetcher/service.js";
import { parseChoiceAnswer, type TypeSafeChoiceQuestion } from "../browser-tools/jev-client.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { loadPersistedConfig } from "../persisted-config.js";
import { isSystemOneExcluded } from "./scope.js";
import { createConfiguredSystemOneDecisionSource } from "./tools.js";
import { CREATE_ROUTING_EXHAUSTED_PCT, isProviderExhaustedForCreate } from "./create-routing.js";

const MAX_TASK_CHARS = 6_000;

export interface TurnRouteInput {
  provider: string;
  cwd: string;
  model: string | undefined;
  thinkingOptionId: string | undefined;
  prompt: AgentPromptInput;
  /**
   * Only the first turn carries the whole task. A follow-up such as "go on" looks
   * trivial on its own, so later turns may escalate but never step down.
   */
  isFirstTurn: boolean;
}

export interface TurnRoute {
  model?: string;
  thinkingOptionId?: string;
}

export type TurnRouter = (input: TurnRouteInput) => Promise<TurnRoute | null>;

/**
 * Jev picks the cheapest sufficient model and thinking depth for each turn, from
 * the per-provider ladders in `daemon.systemOne.routing` (cheapest first).
 */
export function createSystemOneTurnRouter(options: {
  paseoHome: string;
  daemonConfigStore: Pick<DaemonConfigStore, "get">;
  getUsage?: () => Promise<ProviderUsageListResult | null>;
}): TurnRouter {
  return async (input) => {
    const systemOne = options.daemonConfigStore.get().systemOne;
    const ladder = loadPersistedConfig(options.paseoHome).daemon?.systemOne?.routing?.[
      input.provider
    ];
    if (!systemOne?.enabled || !ladder || isSystemOneExcluded(options.paseoHome, input.cwd)) {
      return null;
    }
    const exhausted = await isProviderExhausted(options.getUsage, input.provider);
    // An exhausted provider must not burn more quota: on the first turn fall
    // back to the cheapest rung without spending a Jev call, afterwards keep
    // the current setting.
    if (exhausted) {
      if (!input.isFirstTurn) return null;
      return cheapestRoute(ladder, input.model, input.thinkingOptionId);
    }
    const task = promptText(input.prompt).slice(0, MAX_TASK_CHARS);
    if (task.trim().length === 0) return null;

    const answers = await decideTurnTiers(options, input, task, ladder);
    // Fail-open cheap on the first turn: when Jev is unreachable, fall back
    // to the cheapest rung instead of keeping a costly default.
    if (!answers) {
      if (!input.isFirstTurn) return null;
      return cheapestRoute(ladder, input.model, input.thinkingOptionId);
    }
    return routeFromTiers({
      answers,
      ladder,
      minimumConfidence: systemOne.minimumConfidence,
      currentModel: input.model,
      currentThinking: input.thinkingOptionId,
      isFirstTurn: input.isFirstTurn,
    });
  };
}

function cheapestRoute(
  ladder: { models: string[]; thinking?: string[] },
  currentModel: string | undefined,
  currentThinking: string | undefined,
): TurnRoute | null {
  const route: TurnRoute = {};
  if (ladder.models[0] && ladder.models[0] !== currentModel) route.model = ladder.models[0];
  if (ladder.thinking?.[0] && ladder.thinking[0] !== currentThinking) {
    route.thinkingOptionId = ladder.thinking[0];
  }
  return Object.keys(route).length > 0 ? route : null;
}

async function decideTurnTiers(
  options: {
    paseoHome: string;
    daemonConfigStore: Pick<DaemonConfigStore, "get">;
  },
  input: TurnRouteInput,
  task: string,
  ladder: { models: string[]; thinking?: string[] },
): Promise<Record<string, unknown> | null> {
  const questions: Record<string, TypeSafeChoiceQuestion> = {
    model: {
      type: "choice",
      instructions:
        "Pick the least capable model tier that will still do this coding-agent task well. Cheaper tiers save real money; only escalate when the task needs it.",
      criteria: tierCriteria(ladder.models.length, MODEL_TIER_TEXT),
    },
  };
  if (ladder.thinking) {
    questions.thinking = {
      type: "choice",
      instructions: "Pick the minimum reasoning depth that is still sufficient for this task.",
      criteria: tierCriteria(ladder.thinking.length, THINKING_TIER_TEXT),
    };
  }
  try {
    const decision = await createConfiguredSystemOneDecisionSource(
      options.paseoHome,
      options.daemonConfigStore,
      () => input.cwd,
      "routing",
    ).decide({
      state: { task, provider: input.provider, currentModel: input.model ?? null },
      questions,
    });
    return decision.answers;
  } catch {
    return null;
  }
}

function routeFromTiers(params: {
  answers: Record<string, unknown>;
  ladder: { models: string[]; thinking?: string[] };
  minimumConfidence: number;
  currentModel: string | undefined;
  currentThinking: string | undefined;
  isFirstTurn: boolean;
}): TurnRoute | null {
  const route: TurnRoute = {};
  const model = pickTier(params.answers.model, params.ladder.models, params.minimumConfidence);
  if (model && allowedStep(params.ladder.models, params.currentModel, model, params.isFirstTurn)) {
    route.model = model;
  }
  if (params.ladder.thinking) {
    const thinking = pickTier(
      params.answers.thinking,
      params.ladder.thinking,
      params.minimumConfidence,
    );
    if (
      thinking &&
      allowedStep(params.ladder.thinking, params.currentThinking, thinking, params.isFirstTurn)
    ) {
      route.thinkingOptionId = thinking;
    }
  }
  return Object.keys(route).length > 0 ? route : null;
}

const MODEL_TIER_TEXT = {
  lowest: "trivial questions, lookups, status checks, small mechanical edits",
  middle: "routine implementation, known-cause fixes, straightforward tests",
  highest: "architecture, hard debugging, security, migrations, risky cross-file changes",
};

const THINKING_TIER_TEXT = {
  lowest: "the answer is obvious or the step is mechanical",
  middle: "a few options must be weighed or a moderate plan is needed",
  highest: "deep multi-step reasoning with subtle trade-offs",
};

function tierCriteria(
  count: number,
  text: { lowest: string; middle: string; highest: string },
): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `tier${index + 1}`,
      `Tier ${index + 1} of ${count} (1 = cheapest): ${tierFit(index, count, text)}`,
    ]),
  );
}

function tierFit(
  index: number,
  count: number,
  text: { lowest: string; middle: string; highest: string },
): string {
  if (index === 0) return text.lowest;
  if (index === count - 1) return text.highest;
  return text.middle;
}

// Low confidence keeps the current setting rather than guessing.
function pickTier(answer: unknown, ladder: string[], minimumConfidence: number): string | null {
  const choices = ladder.map((_, index) => `tier${index + 1}`);
  const parsed = parseChoiceAnswer(answer, choices);
  if (parsed.confidence < minimumConfidence) return null;
  return ladder[choices.indexOf(parsed.choice)] ?? null;
}

// After the first turn only escalation is allowed, and a current setting outside
// the ladder is the user's choice, so it is left alone.
function allowedStep(
  ladder: string[],
  current: string | undefined,
  next: string,
  isFirstTurn: boolean,
): boolean {
  if (isFirstTurn) return true;
  const currentIndex = current === undefined ? -1 : ladder.indexOf(current);
  return currentIndex >= 0 && ladder.indexOf(next) > currentIndex;
}

function promptText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") return prompt;
  return prompt
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

async function isProviderExhausted(
  getUsage: (() => Promise<ProviderUsageListResult | null>) | undefined,
  provider: string,
): Promise<boolean> {
  if (!getUsage) return false;
  try {
    const usage = await getUsage();
    const entry: ProviderUsage | undefined = usage?.providers.find(
      (candidate) => candidate.providerId === provider,
    );
    return isProviderExhaustedForCreate(entry, CREATE_ROUTING_EXHAUSTED_PCT);
  } catch {
    return false;
  }
}
