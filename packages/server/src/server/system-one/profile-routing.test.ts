import { afterEach, expect, it, vi } from "vitest";
import {
  createProfileRouter,
  ProfileRoutingUnavailableError,
  validateRoutingPolicy,
  type RoutingProfile,
} from "./profile-routing.js";
import type { AgentRoutingPolicy, ProviderUsage } from "../messages.js";
import {
  TypeSafeSystemOneClient,
  type TypeSafeDecisionRequest,
} from "../browser-tools/jev-client.js";

function usage(providerId: string, usedPct = 10, resetsAt?: string): ProviderUsage {
  return {
    providerId,
    displayName: providerId,
    status: "available",
    planLabel: null,
    windows: [{ id: "session", label: "Session", usedPct, remainingPct: 100 - usedPct, resetsAt }],
    balances: [],
    details: [],
    error: null,
  };
}
const profiles: RoutingProfile[] = ["codex-plus", "codex-work", "codex-business"].map((id) => ({
  id,
  label: id,
  harness: "codex",
  enabled: true,
  models: [
    {
      provider: id,
      id: "gpt-6.1-sol",
      label: "Sol",
      thinkingOptions: [{ id: "medium", label: "Medium" }],
    },
  ],
}));
function fixture(
  entries = profiles.map((profile) => usage(profile.id)),
  catalog = profiles,
  enabled = true,
  routing: Record<string, { models: string[]; thinking?: string[] }> = {},
) {
  let now = Date.parse("2026-09-30T12:00:00Z");
  const decide = vi.fn(async (request: TypeSafeDecisionRequest) => {
    const route = request.questions.route;
    if (route.type !== "choice") throw new Error("expected route choice");
    const choice = Object.keys(route.criteria)[0];
    return {
      model: "jev",
      latencyMs: 1,
      answers: {
        route: {
          choice,
          confidence: 0.99,
          probabilities: Object.fromEntries(
            Object.keys(route.criteria).map((key) => [key, key === choice ? 1 : 0]),
          ),
        },
        reason: {
          choice: "implementation",
          confidence: 0.99,
          probabilities: { mechanical: 0, implementation: 1, complex: 0 },
        },
      },
    };
  });
  const getUsage = vi.fn(async () => ({
    fetchedAt: new Date(now).toISOString(),
    providers: entries,
  }));
  const router = createProfileRouter({
    getProfiles: () => catalog,
    getRouting: () => routing,
    getUsage,
    decisionSource: () => ({ decide }),
    enabled: () => enabled,
    minimumConfidence: () => 0.5,
    now: () => now,
  });
  const input = {
    provider: "codex-plus",
    model: "gpt-6.1-sol",
    thinkingOptionId: "medium",
    cwd: "/private-project",
    prompt: "Implement the task",
    routingMode: "auto" as const,
  };
  return {
    router,
    input,
    decide,
    getUsage,
    setNow: (value: string) => {
      now = Date.parse(value);
    },
  };
}

it("preserves model/effort on a distinct actual account with identical provider family and model", async () => {
  const f = fixture();
  const route = await f.router({
    ...f.input,
    fallback: "quota",
    attemptedProfileIds: ["codex-work"],
  });
  expect(route?.profile).toMatchObject({ provider: "codex-business", thinkingOptionId: "medium" });
  expect(route?.reason).toContain("preserved");
  expect(f.getUsage).toHaveBeenCalledWith(["codex-plus", "codex-work", "codex-business"]);
});
it("skips a future reset and makes the account eligible when a controlled clock expires it", async () => {
  const f = fixture([
    usage("codex-plus", 100, "2026-09-30T13:00:00Z"),
    usage("codex-work", 100, "2026-10-28T13:29:00Z"),
    usage("codex-business"),
  ]);
  expect((await f.router(f.input))?.profile.provider).toBe("codex-business");
  f.setNow("2026-09-30T13:00:00Z");
  expect((await f.router(f.input))?.profile.provider).toBe("codex-plus");
});
it("does not poison account quota cooldowns with capacity failures", async () => {
  const f = fixture();
  expect(
    (
      await f.router({
        ...f.input,
        fallback: "capacity",
        attemptedRoutes: [JSON.stringify(["codex-plus", "gpt-6.1-sol"])],
      })
    )?.profile.provider,
  ).toBe("codex-work");
  expect((await f.router(f.input))?.profile.provider).toBe("codex-plus");
});
it("retains observed quota origins through consecutive failures and exhaustion", async () => {
  const f = fixture();
  await f.router({ ...f.input, fallback: "quota" });
  await f.router({
    ...f.input,
    provider: "codex-work",
    fallback: "quota",
    attemptedProfileIds: ["codex-plus"],
  });
  await expect(
    f.router({
      ...f.input,
      provider: "codex-business",
      fallback: "quota",
      attemptedProfileIds: ["codex-plus", "codex-work"],
    }),
  ).rejects.toBeInstanceOf(ProfileRoutingUnavailableError);
  expect(f.decide).toHaveBeenCalledTimes(2);
  await expect(f.router(f.input)).rejects.toBeInstanceOf(ProfileRoutingUnavailableError);
});
it("requires actual usage and a supported catalog instead of guessing availability", async () => {
  const f = fixture([]);
  await expect(f.router({ ...f.input, fallback: "quota" })).rejects.toThrow("verified usage");
  expect(f.decide).not.toHaveBeenCalled();
});
it("reassesses only after preserving candidates are exhausted, with auditable policy bounds", async () => {
  const models = ["gpt-6-luna", "gpt-6-astra", "claude-opus-5-5"].map((id) => ({
    provider: "claude",
    id,
    label: id,
    thinkingOptions: ["medium", "xhigh", "max"].map((effort) => ({ id: effort, label: effort })),
  }));
  const f = fixture(
    [usage("codex-plus"), usage("claude")],
    [profiles[0], { id: "claude", label: "Claude", enabled: true, harness: "claude", models }],
  );
  const route = await f.router({ ...f.input, fallback: "quota" });
  expect(route?.reason).toContain("routine implementation or execution");
  expect(route?.reason).toContain("Observed quota: Session: 10% used");
  expect(route?.reason).toContain(route!.model);
  const question = f.decide.mock.calls[0][0].questions.route;
  if (question.type !== "choice") throw new Error("expected choice");
  const candidates = Object.values(question.criteria) as Array<{ model: string; effort: string }>;
  expect(candidates.some((candidate) => /astra/.test(candidate.model))).toBe(false);
  expect(
    candidates.some(
      (candidate) => /opus/.test(candidate.model) && ["xhigh", "max"].includes(candidate.effort),
    ),
  ).toBe(false);
  expect(
    candidates.some((candidate) => /luna/.test(candidate.model) && candidate.effort === "max"),
  ).toBe(true);
});

it("does not attempt a capacity retry while a genuine quota reset is still in the future", async () => {
  const f = fixture([usage("codex-plus", 100, "2026-09-30T13:00:00Z"), usage("codex-business")]);
  await expect(f.router({ ...f.input, currentRetry: true })).rejects.toThrow("still quota-limited");
  expect(f.decide).not.toHaveBeenCalled();
  f.setNow("2026-09-30T13:00:00Z");
  await expect(f.router({ ...f.input, currentRetry: true })).resolves.toBeNull();
});

it.each(["off", "unreachable", "low confidence"])(
  "preserves a verified free model/effort route when Jev is %s",
  async (state) => {
    const f = fixture(
      [usage("codex-plus", 100, "2026-09-30T13:00:00Z"), usage("codex-business")],
      profiles,
      state !== "off",
    );
    if (state === "unreachable") f.decide.mockRejectedValue(new Error("timeout"));
    if (state === "low confidence")
      f.decide.mockImplementation(async () => ({
        model: "jev",
        latencyMs: 1,
        answers: {
          route: { choice: "route0", confidence: 0.1, probabilities: { route0: 1 } },
          reason: {
            choice: "implementation",
            confidence: 0.1,
            probabilities: { mechanical: 0, implementation: 1, complex: 0 },
          },
        },
      }));
    const route = await f.router({ ...f.input, fallback: "quota" });
    expect(route).toMatchObject({
      profile: { provider: "codex-business", thinkingOptionId: "medium" },
      model: "gpt-6.1-sol",
    });
    expect(route?.reason).toContain("Preserved model and effort");
  },
);

it.each(["off", "unreachable", "low confidence"])(
  "uses an available default model instead of waiting for an exhausted origin when Jev is %s",
  async (state) => {
    const catalog: RoutingProfile[] = [
      {
        ...profiles[0],
        models: [{ provider: "codex-plus", id: "gpt-6-luna", label: "Luna" }],
      },
      ...profiles.slice(1).map((profile) =>
        Object.assign({}, profile, {
          models: [
            {
              ...profile.models[0],
              thinkingOptions: [
                { id: "xhigh", label: "Xhigh" },
                { id: "high", label: "High" },
              ],
            },
          ],
        }),
      ),
    ];
    const f = fixture(
      [
        usage("codex-plus", 100, "2026-10-04T12:00:00Z"),
        usage("codex-work", 30),
        usage("codex-business", 10),
      ],
      catalog,
      state !== "off",
    );
    if (state === "unreachable") f.decide.mockRejectedValue(new Error("timeout"));
    if (state === "low confidence")
      f.decide.mockImplementation(async (request) => {
        const question = request.questions.route;
        if (question.type !== "choice") throw new Error("expected choice");
        return {
          model: "jev",
          latencyMs: 1,
          answers: {
            route: {
              choice: "route0",
              confidence: 0.25,
              probabilities: Object.fromEntries(
                Object.keys(question.criteria).map((key) => [key, 0.25]),
              ),
            },
            reason: {
              choice: "implementation",
              confidence: 0.34,
              probabilities: {
                mechanical: 0.33,
                implementation: 0.34,
                complex: 0.33,
              },
            },
          },
        };
      });
    expect(
      await f.router({ ...f.input, model: "gpt-6-luna", thinkingOptionId: "high" }),
    ).toMatchObject({
      profile: { provider: "codex-business", thinkingOptionId: "high" },
      model: "gpt-6.1-sol",
      reason: expect.stringContaining("Available default route"),
    });
    await expect(f.router({ ...f.input, currentRetry: true })).rejects.toThrow(
      "still quota-limited",
    );
  },
);

it("does not block a confident route on an uncertain task classification", async () => {
  const f = fixture();
  const original = f.decide.getMockImplementation()!;
  f.decide.mockImplementation(async (request) => {
    const result = await original(request);
    result.answers.reason = {
      choice: "implementation",
      confidence: 0.34,
      probabilities: { mechanical: 0.33, implementation: 0.34, complex: 0.33 },
    };
    return result;
  });
  expect(await f.router(f.input)).toMatchObject({
    profile: { provider: "codex-plus" },
    reason: expect.stringContaining("task classification uncertain"),
  });
});

it("deduplicates repeated configured model and effort choices before asking Jev", async () => {
  const f = fixture();
  const router = createProfileRouter({
    getProfiles: () => profiles,
    getRouting: () => ({
      codex: {
        models: ["gpt-6.1-sol", "gpt-6.1-sol"],
        thinking: ["medium", "medium"],
      },
    }),
    getUsage: f.getUsage,
    decisionSource: () => ({ decide: f.decide }),
    enabled: () => true,
    minimumConfidence: () => 0.5,
  });
  await router(f.input);
  const question = f.decide.mock.calls[0][0].questions.route;
  if (question.type !== "choice") throw new Error("expected choice");
  expect(Object.values(question.criteria)).toHaveLength(profiles.length);
});

it("selects a verified available default in Auto when Jev is unavailable", async () => {
  const f = fixture();
  f.decide.mockRejectedValue(new Error("timeout"));
  await expect(f.router(f.input)).resolves.toMatchObject({
    profile: { provider: "codex-plus" },
    model: "gpt-6.1-sol",
  });
});

it("preserves an already selected supported Opus xhigh while forbidding automatic xhigh", async () => {
  const catalog = ["claude", "claude-extra"].map((id) => ({
    id,
    label: id,
    enabled: true,
    harness: "claude",
    models: [
      {
        id: "claude-opus-5-5",
        provider: id,
        label: "Opus",
        thinkingOptions: [
          { id: "high", label: "High" },
          { id: "xhigh", label: "Xhigh" },
        ],
      },
    ],
  }));
  const f = fixture(
    catalog.map(({ id }) => usage(id)),
    catalog,
  );
  expect(
    await f.router({
      ...f.input,
      provider: "claude",
      model: "claude-opus-5-5",
      thinkingOptionId: "xhigh",
      fallback: "quota",
    }),
  ).toMatchObject({ profile: { provider: "claude-extra", thinkingOptionId: "xhigh" } });
});

it("applies persisted routing model/effort lists by actual provider and inherited harness", async () => {
  const catalog = profiles.map((profile) => ({
    ...profile,
    models: [
      ...profile.models,
      {
        provider: profile.id,
        id: "gpt-6-luna",
        label: "Luna",
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
    ],
  }));
  const decide = vi.fn(async (_request: TypeSafeDecisionRequest) => ({
    model: "jev",
    latencyMs: 1,
    answers: {
      route: { choice: "route0", confidence: 1, probabilities: { route0: 1 } },
      reason: { choice: "mechanical", confidence: 1, probabilities: { mechanical: 1 } },
    },
  }));
  const router = createProfileRouter({
    getProfiles: () => catalog,
    enabled: () => true,
    minimumConfidence: () => 0.5,
    getUsage: async () => ({
      fetchedAt: new Date().toISOString(),
      providers: profiles.map(({ id }) => usage(id)),
    }),
    decisionSource: () => ({ decide }),
    getRouting: () => ({
      codex: { models: ["gpt-6-luna", "unsupported"], thinking: ["low"] },
      "codex-business": { models: ["gpt-6.1-sol", "unsupported"], thinking: ["medium"] },
    }),
  });
  await router({ provider: "codex-plus", cwd: "/project", prompt: "Lookup", routingMode: "auto" });
  const question = decide.mock.calls[0][0].questions.route;
  if (question.type !== "choice") throw new Error("expected route choice");
  expect(Object.values(question.criteria)).toEqual([
    expect.objectContaining({ profile: "codex-business", model: "gpt-6.1-sol", effort: "medium" }),
    expect.objectContaining({ profile: "codex-plus", model: "gpt-6-luna", effort: "low" }),
    expect.objectContaining({ profile: "codex-work", model: "gpt-6-luna", effort: "low" }),
  ]);
});

it.each(["gpt-6.1-sol", "claude-opus-5-5", "claude-sonnet-5-5", "gpt-6-luna"])(
  "quota reassessment prioritizes the remaining model families starting with %s",
  async (expected) => {
    const priority = ["gpt-6.1-sol", "claude-opus-5-5", "claude-sonnet-5-5", "gpt-6-luna"];
    const remaining = priority.slice(priority.indexOf(expected));
    const catalog = remaining.toReversed().map(
      (model, index): RoutingProfile => ({
        id: `account-${index}`,
        label: `Account ${index}`,
        harness: index % 2 ? "codex" : "claude",
        enabled: true,
        models: [
          {
            id: model,
            label: model,
            provider: `account-${index}`,
            thinkingOptions: [{ id: "high", label: "High" }],
          },
        ],
      }),
    );
    const f = fixture(
      catalog.map(({ id }) => usage(id)),
      catalog,
    );
    const selected = await f.router({
      ...f.input,
      provider: "exhausted-origin",
      model: "unsupported-origin-model",
      fallback: "quota",
    });
    expect(selected?.model).toBe(expected);
    const question = f.decide.mock.calls[0][0].questions.route;
    if (question.type !== "choice") throw Error("Expected route choice");
    expect(
      Object.values(question.criteria).map((entry) => (entry as { model: string }).model),
    ).toEqual(remaining);
    expect(question.instructions).toContain("Sol, then Opus, then Sonnet, then Luna");
  },
);

afterEach(() => vi.useRealTimers());

it.each([undefined, "manual"] as const)(
  "honors manual selection without querying usage or Jev (mode %s)",
  async (routingMode) => {
    const f = fixture();
    await expect(
      f.router({ ...f.input, routingMode, provider: "opencode", model: "spark" }),
    ).resolves.toBeNull();
    expect(f.getUsage).not.toHaveBeenCalled();
    expect(f.decide).not.toHaveBeenCalled();
  },
);

it("keeps a manual quota failure on its selected provider even when another account is free", async () => {
  const reset = "2026-09-30T13:00:00Z";
  const f = fixture([
    usage("codex-plus", 100, reset),
    usage("codex-work"),
    usage("codex-business"),
  ]);
  await expect(
    f.router({ ...f.input, routingMode: "manual", fallback: "quota" }),
  ).rejects.toMatchObject({
    resetsAt: new Date(reset).toISOString(),
    message: expect.stringContaining("Your selected provider"),
  });
  expect(f.decide).not.toHaveBeenCalled();
  f.setNow(reset);
  await expect(
    f.router({ ...f.input, routingMode: "manual", currentRetry: true }),
  ).resolves.toBeNull();
});

it("aborts the actual TypeSafe request at the shared two-second usage and decision deadline", async () => {
  vi.useFakeTimers();
  let requestSignal: AbortSignal | undefined;
  const source = new TypeSafeSystemOneClient({
    apiKey: "fixture-only",
    fetchImpl: async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        requestSignal = init!.signal as AbortSignal;
        requestSignal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      }),
  });
  const router = createProfileRouter({
    getProfiles: () => profiles,
    getUsage: async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return { fetchedAt: new Date().toISOString(), providers: profiles.map((p) => usage(p.id)) };
    },
    decisionSource: () => source,
    enabled: () => true,
    minimumConfidence: () => 0.5,
  });
  const pending = router({ ...fixture().input });
  await vi.advanceTimersByTimeAsync(1999);
  expect(requestSignal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toMatchObject({
    model: "gpt-6.1-sol",
    reason: expect.stringContaining("two-second"),
  });
  expect(requestSignal?.aborted).toBe(true);
});

it("bounds a stalled usage snapshot and does not call Jev without verified candidates", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.getUsage.mockImplementationOnce(() => new Promise(() => {}));
  const pending = f.router(f.input);
  await vi.advanceTimersByTimeAsync(2000);
  await expect(pending).resolves.toBeNull();
  expect(f.decide).not.toHaveBeenCalled();
});

const orderedPolicy: AgentRoutingPolicy = {
  strategy: "ordered",
  routes: [
    { provider: "codex-plus", model: "gpt-6-luna", thinkingOptionId: "low" },
    { provider: "codex-plus", model: "gpt-6.1-sol", thinkingOptionId: "low" },
    { provider: "claude", model: "claude-sonnet-5-5", thinkingOptionId: "medium" },
  ],
};
const orderedProfiles: RoutingProfile[] = [
  ...profiles.map((profile) =>
    Object.assign({}, profile, {
      models: ["gpt-6-luna", "gpt-6.1-sol"].map((id) => ({
        provider: profile.id,
        id,
        label: id,
        thinkingOptions: [{ id: "low", label: "Low" }],
      })),
    }),
  ),
  {
    id: "claude",
    label: "Claude",
    enabled: true,
    harness: "claude",
    models: [
      {
        provider: "claude",
        id: "claude-sonnet-5-5",
        label: "Sonnet",
        thinkingOptions: [{ id: "medium", label: "Medium" }],
      },
    ],
  },
];
function orderedFixture(
  entries = orderedProfiles.map((profile) => usage(profile.id)),
  routing: Record<string, { models: string[]; thinking?: string[] }> = {},
) {
  const f = fixture(entries, orderedProfiles, true, routing);
  return { ...f, input: { ...f.input, ...orderedPolicy.routes[0], routingPolicy: orderedPolicy } };
}
it("honors ordered first model and exact private profile without Jev or business usage", async () => {
  const f = orderedFixture();
  expect(await f.router(f.input)).toMatchObject({
    profile: { provider: "codex-plus", thinkingOptionId: "low" },
    model: "gpt-6-luna",
    reason: expect.stringContaining("Ordered route 1/3"),
  });
  expect(f.decide).not.toHaveBeenCalled();
  expect(f.getUsage).toHaveBeenCalledWith(["codex-plus", "claude"]);
});
it("ordered quota fallback skips every model on the exhausted account", async () => {
  const f = orderedFixture();
  expect(await f.router({ ...f.input, fallback: "quota" })).toMatchObject({
    profile: { provider: "claude", thinkingOptionId: "medium" },
    model: "claude-sonnet-5-5",
    reason: expect.stringContaining("after quota on codex-plus/gpt-6-luna"),
  });
  expect(f.decide).not.toHaveBeenCalled();
});
it("ordered capacity fallback tries the next allowed model within the same private account", async () => {
  const f = orderedFixture();
  expect(
    await f.router({
      ...f.input,
      fallback: "capacity",
      attemptedRoutes: [JSON.stringify(["codex-plus", "gpt-6-luna"])],
    }),
  ).toMatchObject({
    profile: { provider: "codex-plus", thinkingOptionId: "low" },
    model: "gpt-6.1-sol",
  });
});
it("ordered exhausted routes cannot escape to an available business account", async () => {
  const f = orderedFixture([
    usage("codex-plus"),
    usage("codex-business"),
    usage("claude", 100, "2026-09-30T13:00:00Z"),
  ]);
  await expect(f.router({ ...f.input, fallback: "quota" })).rejects.toMatchObject({
    message: expect.stringContaining("Other accounts and models are not allowed"),
    resetsAt: "2026-09-30T13:00:00.000Z",
  });
});
it("ordered unknown usage can try only the explicitly authorized profile", async () => {
  const f = orderedFixture([]);
  expect(await f.router(f.input)).toMatchObject({
    profile: { provider: "codex-plus" },
    model: "gpt-6-luna",
    reason: expect.stringContaining("Usage is unavailable"),
  });
  expect(f.decide).not.toHaveBeenCalled();
});
it("ordered choices respect the host model and thinking allowlists", async () => {
  const f = orderedFixture(undefined, {
    "codex-plus": { models: ["gpt-6.1-sol"], thinking: ["low"] },
  });
  expect(await f.router(f.input)).toMatchObject({
    profile: { provider: "codex-plus", thinkingOptionId: "low" },
    model: "gpt-6.1-sol",
  });
  const blocked = orderedFixture(undefined, {
    "codex-plus": { models: ["gpt-6.1-sol"], thinking: ["high"] },
  });
  expect(await blocked.router(blocked.input)).toMatchObject({
    profile: { provider: "claude" },
    model: "claude-sonnet-5-5",
  });
});
it("ordered choices skip unselectable models and unsupported efforts without substituting", async () => {
  const f = orderedFixture();
  const policy: AgentRoutingPolicy = {
    strategy: "ordered",
    routes: [
      { ...orderedPolicy.routes[0], thinkingOptionId: "max" },
      { ...orderedPolicy.routes[0], model: "not-a-model" },
      orderedPolicy.routes[2],
    ],
  };
  expect(await f.router({ ...f.input, routingPolicy: policy })).toMatchObject({
    profile: { provider: "claude", thinkingOptionId: "medium" },
  });
});
it("ordered choice resumes the first preference after its known quota reset", async () => {
  const f = orderedFixture([
    usage("codex-plus", 100, "2026-09-30T13:00:00Z"),
    usage("claude", 100, "2026-09-30T13:00:00Z"),
  ]);
  await expect(f.router({ ...f.input, fallback: "quota" })).rejects.toBeInstanceOf(
    ProfileRoutingUnavailableError,
  );
  f.setNow("2026-09-30T13:00:00Z");
  expect(
    await f.router({
      ...f.input,
      ...orderedPolicy.routes[2],
      fallback: "quota",
      recordFailure: false,
    }),
  ).toMatchObject({ profile: { provider: "codex-plus" }, model: "gpt-6-luna" });
});
it("validates unique ordered exact routes without collapsing private and business profiles", () => {
  expect(() =>
    validateRoutingPolicy({
      ...orderedPolicy,
      routes: [orderedPolicy.routes[0], orderedPolicy.routes[0]],
    }),
  ).toThrow("unique");
  expect(
    validateRoutingPolicy({
      strategy: "ordered",
      routes: [orderedPolicy.routes[0], { ...orderedPolicy.routes[0], provider: "codex-business" }],
    }).routes,
  ).toHaveLength(2);
  expect(() =>
    validateRoutingPolicy({
      ...orderedPolicy,
      routes: [{ ...orderedPolicy.routes[0], provider: "codex-plus " }],
    }),
  ).toThrow("whitespace");
});
