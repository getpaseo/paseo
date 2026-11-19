import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import {
  composerLocator,
  expectComposerDraft,
  fillComposerDraft,
  sendDraftToQueue,
  startRunningMockAgent,
} from "../support/helpers/composer";

const queuedCount = (page: Page) => page.getByRole("button", { name: "Send queued message now" });

test.describe("Editing a queued message from the keyboard", () => {
  test("Up in an empty composer edits the newest queued message", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const agent = await startRunningMockAgent(page, {
      prefix: `edit-queued-${testInfo.workerIndex}-`,
      model: "one-minute-stream",
      prompt: "Keep this turn running while follow-ups are queued.",
    });
    try {
      await fillComposerDraft(page, "First queued follow-up");
      await sendDraftToQueue(page);
      await fillComposerDraft(page, "Second queued follow-up with a typpo");
      await sendDraftToQueue(page);
      await expect(queuedCount(page)).toHaveCount(2);

      // A draft is never replaced: Up only moves the caret.
      await fillComposerDraft(page, "a draft");
      await composerLocator(page).press("ArrowUp");
      await expectComposerDraft(page, "a draft");
      await expect(queuedCount(page)).toHaveCount(2);

      // Empty composer: Up takes the newest queued message back for editing.
      await fillComposerDraft(page, "");
      await composerLocator(page).press("ArrowUp");
      await expectComposerDraft(page, "Second queued follow-up with a typpo");
      await expect(queuedCount(page)).toHaveCount(1);

      // Queueing it again keeps the order: it was last, and it is last again.
      await fillComposerDraft(page, "Second queued follow-up with a typo");
      await sendDraftToQueue(page);
      await expect(queuedCount(page)).toHaveCount(2);
      const first = await page.getByText("First queued follow-up", { exact: true }).boundingBox();
      const second = await page
        .getByText("Second queued follow-up with a typo", { exact: true })
        .boundingBox();
      expect(first && second && first.y < second.y).toBe(true);
    } finally {
      await agent.cleanup();
    }
  });

  test("Down keeps a recalled message that was queued and taken back", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const sent = "Keep this turn running while a recalled message is queued.";
    const agent = await startRunningMockAgent(page, {
      prefix: `edit-recalled-${testInfo.workerIndex}-`,
      model: "one-minute-stream",
      prompt: sent,
    });
    try {
      // Recall the sent prompt and queue it again.
      await fillComposerDraft(page, "");
      await composerLocator(page).press("ArrowUp");
      await expectComposerDraft(page, sent);
      await sendDraftToQueue(page);
      await expect(queuedCount(page)).toHaveCount(1);

      // Take it back, then Down: it is being edited now, not recalled.
      await composerLocator(page).press("ArrowUp");
      await expectComposerDraft(page, sent);
      await expect(queuedCount(page)).toHaveCount(0);
      await composerLocator(page).press("ArrowDown");
      await expectComposerDraft(page, sent);
    } finally {
      await agent.cleanup();
    }
  });
});
