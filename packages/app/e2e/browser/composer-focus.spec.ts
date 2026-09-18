import { expect, test } from "../support/fixtures";
import {
  composerLocator,
  expectComposerDraft,
  expectComposerFocused,
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

test("Enter submits from a narrow desktop pane", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 900 });
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "composer-narrow-desktop-",
    title: "Narrow desktop composer",
  });

  try {
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);

    const composer = composerLocator(page);
    await composer.fill("Send from a narrow desktop pane");
    await composer.press("Enter");

    await expect(
      page.getByTestId("user-message").filter({ hasText: "Send from a narrow desktop pane" }),
    ).toBeVisible();
    await expect(composer).toHaveValue("");
  } finally {
    await agent.cleanup();
  }
});
