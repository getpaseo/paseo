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
  };
  await expect(createSystemOneTurnRouter({ profileRouter })(input)).resolves.toBeNull();
  expect(profileRouter).toHaveBeenCalledWith({ ...input, explicitEffort: false });
});
