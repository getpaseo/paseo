import { expect, test, type Page } from "../support/fixtures";
import {
  composerLocator,
  expectComposerDraft,
  expectComposerVisible,
  submitMessage,
  typeIntoFocusedComposer,
} from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

function userMessages(page: Page) {
  return page.getByTestId("user-message");
}

async function sendAndWaitForMessage(page: Page, text: string, expectedCount: number) {
  await submitMessage(page, text);
  await expect(userMessages(page)).toHaveCount(expectedCount, { timeout: 30_000 });
  await expectComposerDraft(page, "");
}

async function pressInComposer(page: Page, key: string) {
  await composerLocator(page).press(key);
}

test.describe("Composer recall", () => {
  test("Up and Down walk sent messages from an empty composer", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "composer-recall-",
      title: "Composer recall",
    });
    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      await sendAndWaitForMessage(page, "fix the auth bug", 1);
      await sendAndWaitForMessage(page, "add tests", 2);

      await pressInComposer(page, "ArrowUp");
      await expectComposerDraft(page, "add tests");
      await pressInComposer(page, "ArrowUp");
      await expectComposerDraft(page, "fix the auth bug");
      await pressInComposer(page, "ArrowDown");
      await expectComposerDraft(page, "add tests");
      await pressInComposer(page, "ArrowDown");
      await expectComposerDraft(page, "");

      await pressInComposer(page, "ArrowUp");
      await typeIntoFocusedComposer(page, " for login");
      await expectComposerDraft(page, "add tests for login");
      await pressInComposer(page, "ArrowUp");
      await expectComposerDraft(page, "add tests for login");

      await pressInComposer(page, "Enter");
      await expect(userMessages(page)).toHaveCount(3, { timeout: 30_000 });
      await expect(userMessages(page).last()).toContainText("add tests for login");
    } finally {
      await session.cleanup();
    }
  });

  test("a recalled slash message does not open the command picker", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "composer-recall-slash-",
      title: "Composer recall slash",
    });
    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      await sendAndWaitForMessage(page, "/tdd", 1);

      const popover = page.getByTestId("composer-autocomplete-popover").filter({ visible: true });
      await pressInComposer(page, "ArrowUp");
      await expectComposerDraft(page, "/tdd");
      await expect(popover).toHaveCount(0);

      await typeIntoFocusedComposer(page, "x");
      await expect(popover.first()).toBeVisible({ timeout: 30_000 });
    } finally {
      await session.cleanup();
    }
  });
});
