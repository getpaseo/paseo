import type { AgentProfile } from "@getpaseo/protocol/agent-profile";
import type { AgentModelDefinition, AgentPromptInput } from "../agent/agent-sdk-types.js";
import type { ProviderUsageListResult } from "../../services/quota-fetcher/service.js";
import type { ProviderUsage } from "../messages.js";
import { parseChoiceAnswer, type TypeSafeDecisionSource } from "../browser-tools/jev-client.js";

export interface RoutingProfile {
  id: string;
  label: string;
  harness: string;
  enabled: boolean;
  models: readonly AgentModelDefinition[];
  routing?: { models: string[]; thinking?: string[] };
}
export interface ProfileRouteInput {
  provider: string;
  model?: string;
  thinkingOptionId?: string;
  cwd: string;
  prompt: AgentPromptInput;
  fallback?: "quota" | "capacity";
  attemptedProfileIds?: readonly string[];
  attemptedRoutes?: readonly string[];
  explicitEffort?: boolean;
  recordFailure?: boolean;
  currentRetry?: boolean;
  routingMode?: "auto" | "manual";
}
export interface ProfileRoute {
  profile: AgentProfile;
  model: string;
  reason: string;
  resetsAt: string | null;
}
export type ProfileRouter = (input: ProfileRouteInput) => Promise<ProfileRoute | null>;

export class ProfileRoutingUnavailableError extends Error {
  constructor(
    message: string,
    readonly resetsAt: string | null,
  ) {
    super(message);
  }
}

export function limitedReset(usage: ProviderUsage | undefined, now: number): string | null {
  const resets = (usage?.windows ?? [])
    .filter((window) => (window.usedPct ?? 0) >= 95)
    .map((window) => Date.parse(window.resetsAt ?? ""))
    .filter((reset) => Number.isFinite(reset) && reset > now);
  return resets.length ? new Date(Math.max(...resets)).toISOString() : null;
}

export function profileAvailability(
  usage: ProviderUsage | undefined,
  now: number,
): "available" | "limited" | "unknown" {
  if (usage?.status !== "available") return "unknown";
  let observed = false;
  for (const window of usage.windows) {
    if (typeof window.usedPct !== "number" || !Number.isFinite(window.usedPct)) continue;
    const reset = Date.parse(window.resetsAt ?? "");
    if (Number.isFinite(reset) && reset <= now) {
      observed = true;
      continue;
    }
    observed = true;
    if (window.usedPct >= 95) return "limited";
  }
  return observed ? "available" : "unknown";
}

interface ProfileRouterOptions {
  getProfiles: (cwd: string) => readonly RoutingProfile[];
  getUsage: (profileIds: readonly string[]) => Promise<ProviderUsageListResult | null>;
  decisionSource: (cwd: string) => TypeSafeDecisionSource;
  enabled: (cwd: string) => boolean;
  minimumConfidence: () => number;
  now?: () => number;
  getRouting?: () => Record<string, { models: string[]; thinking?: string[] }>;
}

export function createProfileRouter(options: ProfileRouterOptions): ProfileRouter {
  const limits = new Map<string, { resetsAt: string | null; observedAt: number }>();
  return async (input) => {
    if (input.routingMode !== "auto" && !input.fallback && !input.currentRetry) return null;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException("Routing deadline reached", "AbortError")),
      2_000,
    );
    try {
      const now = (options.now ?? Date.now)();
      const profiles = configuredProfiles(
        options.getProfiles(input.cwd),
        options.getRouting?.() ?? {},
      );
      const evidence = await beforeDeadline(
        options.getUsage(profiles.map((profile) => profile.id)),
        controller.signal,
      ).catch(() => null);
      const usage = new Map((evidence?.providers ?? []).map((entry) => [entry.providerId, entry]));
      const reset = limitedReset(usage.get(input.provider), now);
      const attempted = new Set(input.attemptedProfileIds ?? []);
      if (input.fallback === "quota" && input.recordFailure !== false) {
        limits.set(input.provider, { resetsAt: reset, observedAt: now });
        attempted.add(input.provider);
      }
      const eligible = profiles.filter((profile) => {
        const cooldown = limits.get(profile.id);
        if (cooldown) {
          const expired = cooldown.resetsAt !== null && Date.parse(cooldown.resetsAt) <= now;
          const refreshed =
            Date.parse(evidence?.fetchedAt ?? "") > cooldown.observedAt &&
            profileAvailability(usage.get(profile.id), now) === "available";
          if (!expired && !refreshed) return false;
          limits.delete(profile.id);
        }
        if (attempted.has(profile.id)) return false;
        return profileAvailability(usage.get(profile.id), now) === "available";
      });
      const futureResets = profiles
        .flatMap((profile) => {
          const value =
            limits.get(profile.id)?.resetsAt ?? limitedReset(usage.get(profile.id), now);
          return value && Date.parse(value) > now ? [value] : [];
        })
        .sort();
      const unavailable = (message: string) => {
        throw new ProfileRoutingUnavailableError(
          message,
          input.routingMode === "auto"
            ? (futureResets[0] ?? null)
            : (limits.get(input.provider)?.resetsAt ?? reset),
        );
      };
      const currentLimited =
        limits.has(input.provider) ||
        profileAvailability(usage.get(input.provider), now) === "limited";
      if (input.currentRetry) {
        if (currentLimited)
          return unavailable(
            "The current profile is still quota-limited; skipping its capacity retry.",
          );
        return null;
      }
      if (input.routingMode !== "auto") {
        return unavailable(
          input.fallback === "capacity" && !currentLimited
            ? "Your selected model is temporarily at capacity. Retrying the same model; choose Auto to allow another available route."
            : "Your selected provider is quota-limited. Waiting for its reset; choose Auto to allow another available route.",
        );
      }
      return await selectAvailableRoute(
        options,
        currentLimited && !input.fallback ? { ...input, fallback: "quota" } : input,
        eligible,
        usage,
        reset,
        unavailable,
        controller.signal,
      );
    } finally {
      clearTimeout(timeout);
    }
  };
}

export function agentRoutingMode(
  labels: Readonly<Record<string, string>> | undefined,
): "auto" | "manual" {
  return labels?.["pandaos.routing.mode"] === "auto" ? "auto" : "manual";
}

function beforeDeadline<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        return resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        return reject(error);
      },
    );
  });
}

function configuredProfiles(
  profiles: readonly RoutingProfile[],
  routing: Record<string, { models: string[]; thinking?: string[] }>,
): RoutingProfile[] {
  return profiles
    .filter((profile) => profile.enabled)
    .map((profile) =>
      Object.assign({}, profile, { routing: routing[profile.id] ?? routing[profile.harness] }),
    );
}

async function selectAvailableRoute(
  options: ProfileRouterOptions,
  input: ProfileRouteInput,
  eligible: RoutingProfile[],
  usage: Map<string, ProviderUsage>,
  reset: string | null,
  unavailable: (message: string) => never,
  signal: AbortSignal,
): Promise<ProfileRoute | null> {
  const { candidates, preserving } = routingCandidates(eligible, input);
  const preserved = (reason: string) =>
    preserving
      ? candidateRoute(candidates[0], reset, `Preserved model and effort; ${reason}`)
      : null;
  const fallback = (reason: string) => {
    const route = preserved(reason);
    if (route || !candidates.length) return route;
    const model = candidates[0].model.id;
    const effortPriority = (candidate: RoutingCandidate) => {
      const preferred = ["high", candidate.model.defaultThinkingOptionId, "medium", "low"];
      const index = preferred.indexOf(candidate.effort);
      return index < 0 ? preferred.length : index;
    };
    const candidate = candidates
      .filter((entry) => entry.model.id === model)
      .toSorted(
        (left, right) =>
          effortPriority(left) - effortPriority(right) ||
          Math.max(
            ...(usage.get(left.profile.id)?.windows.map((window) => window.usedPct ?? 0) ?? [0]),
          ) -
            Math.max(
              ...(usage.get(right.profile.id)?.windows.map((window) => window.usedPct ?? 0) ?? [0]),
            ),
      )[0];
    return candidateRoute(candidate, reset, `Available default route; ${reason}`);
  };
  if (!options.enabled(input.cwd)) {
    const route = fallback("Jev routing is disabled.");
    if (route) return route;
    if (input.fallback) return unavailable("Jev routing is disabled; reassessment is unavailable.");
    return null;
  }
  if (!candidates.length) {
    if (input.fallback)
      return unavailable(
        "No eligible profile with verified usage and a supported model is available.",
      );
    return null;
  }
  try {
    const route = await beforeDeadline(
      decideRoute(options, input, candidates, preserving, usage, reset, signal),
      signal,
    );
    return route ?? fallback("Jev produced no route.");
  } catch (error) {
    let reason = "The quick model assessment is unavailable.";
    if (error instanceof ProfileRoutingUnavailableError) reason = error.message;
    if (signal.aborted) reason = "The quick model assessment reached its two-second limit.";
    const route = fallback(reason);
    if (route) return route;
    if (error instanceof ProfileRoutingUnavailableError) return unavailable(error.message);
    if (input.fallback)
      return unavailable("Jev reassessment is unavailable; retaining the pending task.");
    return null;
  }
}

interface RoutingCandidate {
  profile: RoutingProfile;
  model: AgentModelDefinition;
  effort: string | undefined;
}

const MODEL_FAMILY_PRIORITY = ["sol", "opus", "sonnet", "luna"] as const;

function modelPriority(model: string): number {
  const rank = MODEL_FAMILY_PRIORITY.findIndex((family) => model.toLowerCase().includes(family));
  return rank < 0 ? MODEL_FAMILY_PRIORITY.length : rank;
}

function routingCandidates(eligible: RoutingProfile[], input: ProfileRouteInput) {
  const routes = new Set(input.attemptedRoutes ?? []);
  const allowedModel = (id: string) => !/astra/i.test(id);
  const allowedEffort = (model: string, effort: string | undefined) =>
    (effort !== "max" || input.explicitEffort || /luna/i.test(model)) &&
    !(/opus/i.test(model) && (effort === "xhigh" || effort === "extra-high"));
  const preserving = input.fallback
    ? eligible.flatMap((profile) => {
        const model = profile.models.find(
          (entry) => entry.id === input.model && entry.isSelectable !== false,
        );
        if (
          !model ||
          !allowedModel(model.id) ||
          routes.has(JSON.stringify([profile.id, model.id])) ||
          (input.thinkingOptionId &&
            !model.thinkingOptions?.some((option) => option.id === input.thinkingOptionId))
        )
          return [];
        return [{ profile, model, effort: input.thinkingOptionId }];
      })
    : [];
  const candidates = preserving.length
    ? preserving
    : eligible.flatMap((profile) =>
        (profile.routing
          ? profile.routing.models.flatMap((id) =>
              profile.models.filter((model) => model.id === id),
            )
          : profile.models
        )
          .filter(
            (model) =>
              model.isSelectable !== false &&
              allowedModel(model.id) &&
              !routes.has(JSON.stringify([profile.id, model.id])),
          )
          .flatMap((model) =>
            (model.thinkingOptions?.map((option) => option.id) ?? [undefined])
              .filter(
                (effort) =>
                  allowedEffort(model.id, effort) &&
                  (!profile.routing?.thinking ||
                    (effort !== undefined && profile.routing.thinking.includes(effort))),
              )
              .map((effort) => ({ profile, model, effort })),
          ),
      );
  return {
    candidates: [
      ...new Map(
        candidates.map((candidate) => [
          JSON.stringify([candidate.profile.id, candidate.model.id, candidate.effort]),
          candidate,
        ]),
      ).values(),
    ].toSorted((left, right) => modelPriority(left.model.id) - modelPriority(right.model.id)),
    preserving: preserving.length > 0,
  };
}

async function decideRoute(
  options: ProfileRouterOptions,
  input: ProfileRouteInput,
  candidates: RoutingCandidate[],
  preserving: boolean,
  usage: Map<string, ProviderUsage>,
  reset: string | null,
  signal: AbortSignal,
): Promise<ProfileRoute | null> {
  const unavailable = (message: string): never => {
    throw new ProfileRoutingUnavailableError(message, null);
  };
  const task =
    typeof input.prompt === "string"
      ? input.prompt
      : input.prompt.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  if (!task.trim()) return null;
  const criteria = Object.fromEntries(
    candidates.map((candidate, index) => [
      `route${index}`,
      {
        profile: candidate.profile.id,
        harness: candidate.profile.harness,
        model: candidate.model.id,
        effort: candidate.effort ?? null,
        usedPct: usage.get(candidate.profile.id)?.windows.map((window) => window.usedPct),
      },
    ]),
  );
  signal.throwIfAborted();
  const decision = await options.decisionSource(input.cwd).decide(
    {
      state: {
        task: task.slice(0, 6000),
        current: { profile: input.provider, model: input.model, effort: input.thinkingOptionId },
        reassessment: !!input.fallback && !preserving,
      },
      questions: {
        route: {
          type: "choice",
          instructions:
            "Choose the best sufficient existing route for the task. Model-family priority is Sol, then Opus, then Sonnet, then Luna, ahead of provider affinity and catalog order when routes are equally sufficient. GPT-6.1 Sol is the default; Opus 5.5 for complex architecture/debugging; Sonnet 5.5 high for execution. Select sufficient supported effort, never maximum by default. Prefer lower account usage when routes are equally suitable. Preserve model and effort whenever the choices allow it.",
          criteria,
        },
        reason: {
          type: "choice",
          instructions:
            "Classify the task requirement that explains the selected model and effort.",
          criteria: {
            mechanical: "Lookup or mechanical change",
            implementation: "Routine implementation or execution",
            complex: "Architecture, hard debugging or subtle security work",
          },
        },
      },
    },
    { signal },
  );
  const selected = parseChoiceAnswer(decision.answers.route, Object.keys(criteria));
  const rationale = parseChoiceAnswer(decision.answers.reason, [
    "mechanical",
    "implementation",
    "complex",
  ]);
  if (selected.confidence < options.minimumConfidence())
    return unavailable("Jev did not produce a confident route.");
  const candidate = candidates[Number(selected.choice.slice(5))];
  if (!candidate) return unavailable("Jev selected an unknown route.");
  const requirement =
    rationale.confidence < options.minimumConfidence()
      ? "task classification uncertain"
      : {
          mechanical: "a lookup or small mechanical change",
          implementation: "routine implementation or execution",
          complex: "complex architecture, debugging or security work",
        }[rationale.choice];
  const observedUsage = (usage.get(candidate.profile.id)?.windows ?? [])
    .filter((window) => typeof window.usedPct === "number" && Number.isFinite(window.usedPct))
    .map((window) => `${window.label}: ${Math.round(window.usedPct! * 10) / 10}% used`)
    .join(", ");
  return candidateRoute(
    candidate,
    reset,
    `Jev selected ${candidate.profile.label} · ${candidate.model.id}${candidate.effort ? ` · ${candidate.effort}` : ""} for ${requirement}.${preserving ? " Jev preserved model and effort." : ""}${observedUsage ? ` Observed quota: ${observedUsage}.` : ""}`,
  );
}

function candidateRoute(
  candidate: RoutingCandidate,
  reset: string | null,
  reason: string,
): ProfileRoute {
  return {
    profile: {
      id: candidate.profile.id,
      name: candidate.profile.label,
      provider: candidate.profile.id,
      model: candidate.model.id,
      thinkingOptionId: candidate.effort,
    },
    model: candidate.model.id,
    resetsAt: reset,
    reason,
  };
}
