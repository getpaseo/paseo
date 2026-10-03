import { expect, it, vi } from "vitest";
import { createSystemOneTurnRouter } from "./model-routing.js";

it("uses the same actual-profile router for a native session turn", async () => {
  const profileRouter = vi.fn(async () => null);
  const input = {
    provider: "codex-business",
    model: "gpt-6.1-sol",
    thinkingOptionId: "medium",
    cwd: "/private-project",
    prompt: "Implement the task",
    isFirstTurn: true,
    routingMode: "auto" as const,
    routingPolicy: {
      strategy: "ordered" as const,
      routes: [{ provider: "codex-business", model: "gpt-6.1-sol", thinkingOptionId: "medium" }],
    },
  };
  await expect(createSystemOneTurnRouter({ profileRouter })(input)).resolves.toBeNull();
  expect(profileRouter).toHaveBeenCalledWith({ ...input, explicitEffort: false });
});

it("does not invoke automatic turn routing without explicit Auto mode", async () => {
  const profileRouter = vi.fn(async () => null);
  await expect(
    createSystemOneTurnRouter({ profileRouter })({
      provider: "opencode",
      model: "spark",
      thinkingOptionId: "high",
      cwd: "/project",
      prompt: "Keep mymodel",
      isFirstTurn: true,
    }),
  ).resolves.toBeNull();
  expect(profileRouter).not.toHaveBeenCalled();
});
