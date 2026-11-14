import { expect, test } from "../support/fixtures";
import { composerLocator, expectComposerVisible } from "../support/helpers/composer";
import {
  installDictationTranscriptHarness,
  installSyntheticMicrophone,
} from "../support/helpers/dictation";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const TRANSCRIPT = "Recovered on the second attempt";

test.describe("Dictation empty result", () => {
  test.describe.configure({ timeout: 240_000 });

  test("explains an empty transcript and retries the same recording", async ({ page }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "dictation-empty-",
      title: "Empty dictation",
    });
    await installSyntheticMicrophone(page);
    const harness = await installDictationTranscriptHarness(page, ["", TRANSCRIPT]);
    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);

      await page.getByRole("button", { name: "Start dictation" }).click();
      await harness.waitForAudio();
      await page.getByRole("button", { name: "Insert transcription", exact: true }).click();

      await expect(
        page.getByText("No speech was recognized. Tap retry to try again.", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Retry dictation", exact: true }).click();

      await expect(composerLocator(page)).toHaveValue(TRANSCRIPT);
    } finally {
      await agent.cleanup();
    }
  });

  test("says when the microphone only delivered silence", async ({ page }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "dictation-silent-",
      title: "Silent dictation",
    });
    await installSyntheticMicrophone(page, { silent: true });
    const harness = await installDictationTranscriptHarness(page, [""]);
    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);

      await page.getByRole("button", { name: "Start dictation" }).click();
      await harness.waitForAudio();
      await page.getByRole("button", { name: "Insert transcription", exact: true }).click();

      await expect(
        page.getByText("Only silence was recorded. Check your microphone.", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Cancel dictation", exact: true }).click();
      await expect(composerLocator(page)).toBeEditable();
    } finally {
      await agent.cleanup();
    }
  });
});
