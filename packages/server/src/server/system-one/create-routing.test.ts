import { expect, it, vi } from "vitest";
import { createSystemOneCreateRouter } from "./create-routing.js";

it.each([false, true])(
  "routes human and delegated creation (agent scoped: %s)",
  async (isAgentScoped) => {
    const profileRouter = vi.fn(async () => ({
      profile: {
        id: "codex-business",
        name: "Business",
        provider: "codex-business",
        thinkingOptionId: "medium",
      },
      model: "gpt-6.1-sol",
      reason: "Jev reassessed: implementation",
      resetsAt: null,
    }));
    const router = createSystemOneCreateRouter({ profileRouter });
    await expect(
      router({
        requestedProvider: "codex-plus",
        requestedModel: "gpt-6.1-sol",
        requestedThinking: "max",
        prompt: "Implement the task",
        cwd: "/project",
        isAgentScoped,
        routingMode: "auto",
      }),
    ).resolves.toMatchObject({
      provider: "codex-business",
      model: "gpt-6.1-sol",
      thinkingOptionId: "medium",
    });
    expect(profileRouter).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex-plus",
        explicitEffort: !isAgentScoped,
        thinkingOptionId: "max",
      }),
    );
  },
);

it.each([undefined, "manual"] as const)(
  "keeps explicit create model without invoking routing (mode %s)",
  async (routingMode) => {
    const profileRouter = vi.fn(async () => null);
    const router = createSystemOneCreateRouter({ profileRouter });
    await expect(
      router({
        requestedProvider: "opencode",
        requestedModel: "spark",
        requestedThinking: "high",
        prompt: "Build it",
        cwd: "/project",
        isAgentScoped: false,
        routingMode,
      }),
    ).resolves.toBeNull();
    expect(profileRouter).not.toHaveBeenCalled();
  },
);

it("records an unverified creation preflight so the first turn does not wait twice", async () => {
  const router = createSystemOneCreateRouter({ profileRouter: async () => null });
  await expect(
    router({
      requestedProvider: "opencode",
      requestedModel: undefined,
      requestedThinking: undefined,
      prompt: "Build it",
      cwd: "/project",
      isAgentScoped: false,
      routingMode: "auto",
    }),
  ).resolves.toMatchObject({
    provider: "opencode",
    routingNotice: { status: "unverified", toProfile: "opencode" },
  });
});

it("forwards the exact ordered policy into creation routing", async () => {
  const profileRouter = vi.fn(async () => null);
  const routingPolicy = {
    strategy: "ordered" as const,
    routes: [{ provider: "codex-plus", model: "gpt-6-luna", thinkingOptionId: "low" }],
  };
  await createSystemOneCreateRouter({ profileRouter })({
    requestedProvider: "codex-plus",
    requestedModel: "gpt-6-luna",
    requestedThinking: "low",
    prompt: "Task",
    cwd: "/project",
    isAgentScoped: false,
    routingMode: "auto",
    routingPolicy,
  });
  expect(profileRouter).toHaveBeenCalledWith(expect.objectContaining({ routingPolicy }));
});
