import { test } from "../support/fixtures";
import {
  closePageAndVerifyFooterCleanup,
  expectPinnedFooter,
  recoverFooterOnSessionChange,
  repinTimelineCardsAndReload,
  scrollHistoryAndUsePinnedControls,
  switchHostsAndVerifyFooterIsolation,
  unpinAndRestoreTimelineCards,
  withTimelineFooterPlugin,
} from "../support/helpers/plugin-timeline-footer";

for (const width of [1100, 390]) {
  test(`plugin footers pin outside real history and restore rows without gaps at width ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await withTimelineFooterPlugin(page, info, async (agent) => {
      await expectPinnedFooter(page, agent);
      await scrollHistoryAndUsePinnedControls(page, agent, info);
      await unpinAndRestoreTimelineCards(page);
      await repinTimelineCardsAndReload(page, agent);
      await recoverFooterOnSessionChange(page, agent);
    });
  });
}

test("a footer stays on its owning host when switching between real daemons", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await withTimelineFooterPlugin(page, info, async (primary) => {
    await switchHostsAndVerifyFooterIsolation(page, primary);
  });
});

test("closing the page still removes the footer plugin and restores daemon configuration", async ({
  page,
}, info) => {
  await closePageAndVerifyFooterCleanup(page, info);
});
