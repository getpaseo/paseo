import { expect, test } from "../support/fixtures";
import { composerLocator, expectComposerVisible } from "../support/helpers/composer";
import {
  discardDictation,
  expectEmptyDictation,
  installSyntheticMicrophone,
  observeDictation,
  recordDictation,
  retryDictation,
} from "../support/helpers/dictation";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

// Silence is finalized by the real daemon without calling a transcription service.
// A closed local endpoint makes an unexpected transcription request fail the test.
test.use({
  e2eDaemonEnvironment: {
    PASEO_DICTATION_ENABLED: "1",
    PASEO_DICTATION_SILENCE_PEAK_THRESHOLD: "300",
    OPENAI_API_KEY: "unused-for-silent-recordings",
    OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
  },
});

test.describe("Dictation empty result", () => {
  test("the daemon accepts the same recording through repeated empty-result retries", async ({
    page,
  }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "dictation-empty-",
      title: "Empty dictation",
    });
    await installSyntheticMicrophone(page, { silent: true });
    const observed = observeDictation(page);
    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      await recordDictation(page, observed);
      await expectEmptyDictation(page);
      await retryDictation(page);
      await expectEmptyDictation(page);
      await retryDictation(page);
      await expectEmptyDictation(page);

      expect(observed.recordings).toHaveLength(3);
      expect(observed.recordings[0].audio.length).toBeGreaterThan(0);
      expect(observed.recordings[0].finalSeq).toBe(observed.recordings[0].audio.length - 1);
      expect(observed.recordings[0].text).toBe("");
      expect(observed.recordings[1]).toEqual(observed.recordings[0]);
      expect(observed.recordings[2]).toEqual(observed.recordings[0]);
      await discardDictation(page);
      await expect(composerLocator(page)).toBeEditable();
      await expect(composerLocator(page)).toHaveValue("");
    } finally {
      await agent.cleanup();
    }
  });

  test.describe("narrow composer", () => {
    test.use({ viewport: { width: 390, height: 844 } });
    test("explains and discards an empty result", async ({ page }) => {
      const agent = await seedMockAgentWorkspace({
        repoPrefix: "dictation-silent-",
        title: "Silent dictation",
      });
      await installSyntheticMicrophone(page, { silent: true });
      const observed = observeDictation(page);
      try {
        await openAgentRoute(page, agent);
        await expectComposerVisible(page);
        await recordDictation(page, observed);
        await expectEmptyDictation(page);
        await discardDictation(page);
        await expect(composerLocator(page)).toBeEditable();
        await expect(composerLocator(page)).toHaveValue("");
      } finally {
        await agent.cleanup();
      }
    });
  });
});
