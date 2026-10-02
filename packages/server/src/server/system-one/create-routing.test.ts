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
