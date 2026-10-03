import { test } from "../support/fixtures";
import {
  observeTimelinePages,
  openOnlyTimelineTail,
  recordUpwardTraversal,
  reportScrollJumps,
  scrollCadences,
  withVariedTimeline,
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
