import { expect, test } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import {
  installDictationTranscriptHarness,
  installSyntheticMicrophone,
} from "../support/helpers/dictation";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { openVoiceSettings } from "../support/helpers/voice-settings";

const TRANSCRIPT = "Transcribed again from the saved recording";
const EMPTY_REASON = "No speech was recognized. Tap retry to try again.";

test.describe("Recent dictations", () => {
  test.describe.configure({ timeout: 240_000 });

  test("keeps a dismissed empty dictation and transcribes it again from Settings", async ({
    page,
  }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "dictation-recordings-",
      title: "Recent dictations",
    });
    await installSyntheticMicrophone(page);
    const harness = await installDictationTranscriptHarness(page, ["", TRANSCRIPT]);
    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      await page.getByRole("button", { name: "Start dictation" }).click();
      await harness.waitForAudio();
      await page.getByRole("button", { name: "Insert transcription", exact: true }).click();
      await expect(page.getByText(EMPTY_REASON, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Cancel dictation", exact: true }).click();

      await openVoiceSettings(page);
      const section = page.getByTestId("voice-recent-dictations");
      await expect(section.getByText(EMPTY_REASON, { exact: true })).toBeVisible();

      await section.getByRole("button", { name: "Retry", exact: true }).click();

      await expect(section.getByText(TRANSCRIPT, { exact: true })).toBeVisible();
      await expect(section.getByText(EMPTY_REASON, { exact: true })).toHaveCount(0);
    } finally {
      await agent.cleanup();
    }
  });
});
