import { expect, test, type Page } from "../support/fixtures";
import {
  composerLocator,
  expectComposerDraft,
  expectComposerFocused,
  expectComposerNotFocused,
  expectComposerVisible,
  submitMessage,
  typeIntoFocusedComposer,
} from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { readScrollMetrics } from "../support/helpers/agent-bottom-anchor";
import { seedLongMockAgentTimeline } from "../support/helpers/timeline-pagination";

test("clicking chat text or background focuses the feed for keyboard paging", async ({ page }) => {
  const agent = await seedLongMockAgentTimeline({ turns: 8 });

  try {
    await openAgentRoute(page, agent);
    const composer = composerLocator(page);
    const feed = page.getByTestId("agent-chat-scroll").filter({ visible: true });
    await composer.fill("Keep this draft");
    await feed.getByText(agent.newestPrompt, { exact: true }).click();
    await expect(feed).toBeFocused();

    const beforePaging = await readScrollMetrics(page);
    expect(beforePaging.offsetY).toBeGreaterThan(beforePaging.viewportHeight);
    await page.keyboard.press("PageUp");
    await expect
      .poll(async () => (await readScrollMetrics(page)).offsetY)
      .toBeLessThan(beforePaging.offsetY - beforePaging.viewportHeight / 2);
    await page.keyboard.press("PageDown");
    await expect
      .poll(async () => (await readScrollMetrics(page)).distanceFromBottom)
      .toBeLessThanOrEqual(2);

    await composer.click();
    await expectComposerFocused(page);
    await feed.click({ position: { x: 2, y: 40 } });
    await expect(feed).toBeFocused();
    await page.keyboard.press("PageUp");
    await expect
      .poll(async () => (await readScrollMetrics(page)).distanceFromBottom)
      .toBeGreaterThan(beforePaging.viewportHeight / 2);
    await agent.client.sendAgentMessage(agent.agentId, "emit 1 coalesced agent stream updates");
    await agent.client.waitForFinish(agent.agentId, 15_000);
    expect((await readScrollMetrics(page)).distanceFromBottom).toBeGreaterThan(
      beforePaging.viewportHeight / 2,
    );
    await expectComposerDraft(page, "Keep this draft");
  } finally {
    await agent.cleanup();
  }
});

test("focusing the feed preserves assistant text selection and code copy controls", async ({
  page,
  context,
}) => {
  const sentence = "Select this assistant sentence.";
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-focus-selection-",
    title: "Chat focus selection",
    initialPrompt: "Render text and code.",
    featureValues: {
      mockAssistantResponse: `${sentence}\n\n\`\`\`bash\necho example\n\`\`\``,
    },
  });

  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await openAgentRoute(page, agent);
    await composerLocator(page).fill("Keep this draft");

    const feed = page.getByTestId("agent-chat-scroll").filter({ visible: true });
    await feed.getByText(sentence, { exact: true }).click({ clickCount: 3 });
    await expect(feed).toBeFocused();
    expect(await page.evaluate(() => window.getSelection()?.toString().trim())).toBe(sentence);
    await page.keyboard.press("ControlOrMeta+c");
    expect((await page.evaluate(() => navigator.clipboard.readText())).trim()).toBe(sentence);

    const code = feed.locator('[data-paseo-markdown-language="bash"]');
    await code.hover();
    await code.locator("[data-paseo-markdown-ignore]").click();
    await expect(feed).not.toBeFocused();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("echo example");
    await expectComposerDraft(page, "Keep this draft");
  } finally {
    await agent.cleanup();
  }
});

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
