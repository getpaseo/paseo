import { expect, test } from "../support/fixtures";
import { composerLocator, expectComposerVisible } from "../support/helpers/composer";
import {
  discardDictation,
  expectEmptyDictation,
  installDictationTranscriptHarness,
  installSyntheticMicrophone,
  recordDictation,
  retryDictation,
} from "../support/helpers/dictation";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const TRANSCRIPT = "Recovered on the second retry";

test.describe("Dictation empty result", () => {
  test("explains an empty result and replays the same audio through repeated retries", async ({
    page,
  }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "dictation-empty-",
      title: "Empty dictation",
    });
    await installSyntheticMicrophone(page);
    const harness = await installDictationTranscriptHarness(page, ["", "", TRANSCRIPT]);
    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      await recordDictation(page, harness);
      await expectEmptyDictation(page);
      await retryDictation(page);
      await expectEmptyDictation(page);
      await retryDictation(page);

      await expect(composerLocator(page)).toHaveValue(TRANSCRIPT);
      expect(harness.recordings).toHaveLength(3);
      expect(harness.recordings[0].length).toBeGreaterThan(0);
      expect(harness.recordings[1]).toEqual(harness.recordings[0]);
      expect(harness.recordings[2]).toEqual(harness.recordings[0]);
    } finally {
      await agent.cleanup();
    }
  });

  test.describe("narrow composer", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("explains and discards an empty result from a silent microphone", async ({ page }) => {
      const agent = await seedMockAgentWorkspace({
        repoPrefix: "dictation-silent-",
        title: "Silent dictation",
      });
      await installSyntheticMicrophone(page, { silent: true });
      const harness = await installDictationTranscriptHarness(page, [""]);
      try {
        await openAgentRoute(page, agent);
        await expectComposerVisible(page);
        await recordDictation(page, harness);
        await expectEmptyDictation(page);
        await discardDictation(page);
        await expect(composerLocator(page)).toBeEditable();
        await expect(composerLocator(page)).toHaveValue("");
      } finally {
        await agent.cleanup();
      }
    });
  });

  test("keeps the latest partial text when the final response is empty", async ({ page }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "dictation-partial-",
      title: "Partial dictation",
    });
    await installSyntheticMicrophone(page);
    const harness = await installDictationTranscriptHarness(page, [""], {
      partialTranscript: "Words already recognized",
    });
    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      await recordDictation(page, harness);
      await expect(composerLocator(page)).toHaveValue("Words already recognized");
    } finally {
      await agent.cleanup();
    }
  });
});
