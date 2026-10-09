import { expect, test, type Page } from "../support/fixtures";
import {
  expectComposerDraft,
  expectComposerFocused,
  expectComposerNotFocused,
  expectComposerVisible,
  submitMessage,
  typeIntoFocusedComposer,
} from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test("submitting a message leaves the composer ready for the next message", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "composer-focus-",
    title: "Composer focus",
  });

  try {
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);

    await submitMessage(page, "First message");
    await expectComposerFocused(page);

    await typeIntoFocusedComposer(page, "Second message");
    await expectComposerDraft(page, "Second message");
  } finally {
    await agent.cleanup();
  }
});

test("opening an agent focuses the composer when a mouse drives the UI", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "composer-focus-open-",
    title: "Composer focus on open",
  });

  try {
    await openAgentRoute(page, agent);
    await expectComposerFocused(page);
  } finally {
    await agent.cleanup();
  }
});

async function waitForAnimationFrames(page: Page, count: number): Promise<void> {
  await page.evaluate(async (frames) => {
    for (let frame = 0; frame < frames; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, count);
}

test.describe("touch screen wide enough for the desktop layout", () => {
  // A tablet or an unfolded foldable gets the desktop layout, but focusing the
  // composer there raises the on-screen keyboard over the conversation.
  test.use({ viewport: { width: 1024, height: 768 }, isMobile: true, hasTouch: true });

  test("opening an agent leaves the composer unfocused", async ({ page }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "composer-focus-touch-",
      title: "Composer focus on touch",
    });

    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      expect(
        await page.evaluate(() => window.matchMedia("(hover: hover) and (pointer: fine)").matches),
      ).toBe(false);
      // Autofocus makes its first attempt on the next animation frame.
      await waitForAnimationFrames(page, 4);
      await expectComposerNotFocused(page);
    } finally {
      await agent.cleanup();
    }
  });
});
