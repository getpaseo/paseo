import { test } from "../support/fixtures";
import { expect } from "@playwright/test";
import {
  expectImageSpaceReserved,
  observeTimelinePages,
  openOnlyTimelineTail,
  recordUpwardTraversal,
  reportScrollJumps,
  scrollCadences,
  withVariedTimeline,
  withStreamingReader,
  holdParagraphThroughCompletion,
} from "../support/helpers/timeline-scroll-smoothness";

for (const cadence of scrollCadences) {
  test(`varied timeline preserves reading position during ${cadence.name} upward scrolling`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await withVariedTimeline(async (agent, newestPrompt) => {
      const pages = observeTimelinePages(page, agent.agentId);
      await openOnlyTimelineTail(page, agent, newestPrompt, pages);
      const frames = await recordUpwardTraversal(page, cadence, testInfo);
      await reportScrollJumps(page, testInfo, frames, pages);
    });
  });
}

test("reserves image space before its response arrives", async ({ page }, testInfo) => {
  await expectImageSpaceReserved(page, testInfo);
});

test("holds a paragraph still while a mixed response streams and completes", async ({ page }) => {
  await withStreamingReader(async (agent) => {
    const reading = await holdParagraphThroughCompletion(page, agent);
    expect(
      reading.textGrowth,
      "the held reader must observe an actively growing response",
    ).toBeGreaterThan(1000);
    expect(
      reading.maxFollowGap,
      "follow-bottom must catch each streamed commit before the next frame",
    ).toBeLessThanOrEqual(1);
    expect(
      reading.maxDrift,
      "streaming must preserve the held paragraph's viewport position",
    ).toBeLessThanOrEqual(1);
    expect(reading.retained, "completion must retain the paragraph's DOM node").toBe(true);
  });
});
