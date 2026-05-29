import { expect, test, type Page } from "./fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "./helpers/mock-agent";
import {
  composerLocator,
  expectComposerEditable,
  expectComposerVisible,
  fillComposerDraft,
  submitMessage,
} from "./helpers/composer";

async function expectUserMessageCount(page: Page, expected: number): Promise<void> {
  await expect(page.getByTestId("user-message")).toHaveCount(expected, { timeout: 15_000 });
}

async function expectIdleComposer(page: Page): Promise<void> {
  await expectComposerEditable(page);
  await expect(page.getByRole("button", { name: /stop|cancel/i })).toHaveCount(0, {
    timeout: 15_000,
  });
}

async function expectNoLoadingRegressionAfterIdle(page: Page): Promise<void> {
  await expectIdleComposer(page);
  await page.waitForTimeout(1_000);
  await expectIdleComposer(page);
}

test.describe("User message UI contract", () => {
  test("dedupes mock provider user_message echoes across multi-turn sends", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "user-message-contract-e2e-",
      title: "User message contract e2e",
    });
    const prompts = [
      "emit 1 coalesced agent stream updates for user message contract turn one.",
      "emit 1 coalesced agent stream updates for user message contract turn two.",
      "emit 1 coalesced agent stream updates for user message contract turn three.",
    ];

    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);

      for (let index = 0; index < prompts.length; index += 1) {
        const prompt = prompts[index]!;
        await submitMessage(page, prompt);
        await expect(page.getByText(prompt, { exact: true })).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("stress-update-0", { exact: true }).first()).toBeVisible({
          timeout: 15_000,
        });
        await expectUserMessageCount(page, index + 1);
        await expectNoLoadingRegressionAfterIdle(page);
      }

      await fillComposerDraft(page, "append");
      await composerLocator(page).evaluate((element) => element.blur());
      await expectUserMessageCount(page, 3);
      await expectIdleComposer(page);
    } finally {
      await session.cleanup();
    }
  });
});
