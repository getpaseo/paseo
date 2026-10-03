import { test } from "../support/fixtures";
import { expect } from "@playwright/test";
import {
  findScrollJumps,
  type ScrollFrame,
  observeTimelinePages,
  openOnlyTimelineTail,
  recordUpwardTraversal,
  reportScrollJumps,
  scrollCadences,
  withVariedTimeline,
} from "../support/helpers/timeline-scroll-smoothness";

test("scroll detector distinguishes entered image growth from a simultaneous viewport jump", () => {
  const before: ScrollFrame = {
    at: 1000,
    scrollTop: 1000,
    scrollHeight: 5000,
    viewportHeight: 800,
    virtualized: true,
    loading: false,
    rows: [
      { id: "image", top: -150, height: 150 },
      { id: "reading", top: 0, height: 100 },
    ],
    anchor: "reading",
    wheelTotal: 0,
    lastWheelAt: 0,
    inputFinishedAt: null,
    imageLoads: 0,
    mounted: 0,
    unmounted: 0,
  };
  const after: ScrollFrame = {
    ...before,
    at: 1400,
    wheelTotal: 100,
    lastWheelAt: 1050,
    rows: [
      { id: "image", top: -50, height: 1150 },
      { id: "reading", top: 1100, height: 100 },
    ],
  };
  expect(findScrollJumps([before, after])).toEqual([]);
  expect(
    findScrollJumps([
      before,
      { ...after, rows: after.rows.map((row) => ({ ...row, top: row.top - 500 })) },
    ]),
  ).toHaveLength(1);
  expect(
    findScrollJumps([
      { ...before, anchor: "image", rows: [{ id: "image", top: 0, height: 150 }] },
      { ...after, rows: [{ id: "image", top: 600, height: 1150 }] },
    ]),
  ).toHaveLength(1);
});

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
