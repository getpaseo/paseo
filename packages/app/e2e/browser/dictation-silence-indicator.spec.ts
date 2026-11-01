import { expect, test, type Page } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import {
  installDictationTranscriptHarness,
  installSyntheticMicrophone,
} from "../support/helpers/dictation";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

// Light theme tokens: surface3 while silent, accent while sound is heard.
const SILENT_BACKGROUND = "rgb(228, 228, 231)";
const HEARING_BACKGROUND = "rgb(32, 116, 74)";

async function recordWithMicrophone(page: Page, options: { silent: boolean }) {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "dictation-silence-",
    title: "Silence indicator",
  });
  await installSyntheticMicrophone(page, options);
  const harness = await installDictationTranscriptHarness(page, []);
  await openAgentRoute(page, agent);
  await expectComposerVisible(page);
  await page.getByRole("button", { name: "Start dictation" }).click();
  await harness.waitForAudio();
  return agent;
}

test.describe("Dictation silence indicator", () => {
  test.describe.configure({ timeout: 240_000 });

  test("turns the recorder gray while the microphone hears only silence", async ({ page }) => {
    const agent = await recordWithMicrophone(page, { silent: true });
    try {
      await expect(page.getByTestId("dictation-overlay")).toHaveCSS(
        "background-color",
        SILENT_BACKGROUND,
      );
    } finally {
      await page.getByRole("button", { name: "Cancel dictation", exact: true }).click();
      await agent.cleanup();
    }
  });

  test("keeps the accent color while sound is heard", async ({ page }) => {
    const agent = await recordWithMicrophone(page, { silent: false });
    try {
      await expect(page.getByTestId("dictation-overlay")).toHaveCSS(
        "background-color",
        HEARING_BACKGROUND,
      );
    } finally {
      await page.getByRole("button", { name: "Cancel dictation", exact: true }).click();
      await agent.cleanup();
    }
  });
});
