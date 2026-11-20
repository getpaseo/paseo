import { expect, test, type Page } from "../support/fixtures";
import {
  composerLocator,
  expectComposerDraft,
  expectComposerVisible,
  fillComposerDraft,
  typeIntoFocusedComposer,
} from "../support/helpers/composer";
import { expectVisibleAgentSurfacesIdle } from "../support/helpers/agent-stream";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

function userMessages(page: Page) {
  return page.getByTestId("user-message");
}

async function sendDraftWhenReady(page: Page) {
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await pressInComposer(page, "Enter");
}

async function sendAndWaitForMessage(page: Page, text: string, expectedCount: number) {
  await fillComposerDraft(page, text);
  await sendDraftWhenReady(page);
  await expect(userMessages(page)).toHaveCount(expectedCount, { timeout: 30_000 });
  await expectComposerDraft(page, "");
}

async function pressInComposer(page: Page, key: string) {
  await composerLocator(page).press(key);
}

test.describe("Composer recall", () => {
  test("recalls, edits, and sends messages while keeping slash autocomplete usable", async ({
    page,
  }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "composer-recall-",
      title: "Composer recall",
    });
    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      await test.step("walk sent history, edit a recalled draft, and send it", async () => {
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

        await sendDraftWhenReady(page);
        await expect(userMessages(page)).toHaveCount(3, { timeout: 30_000 });
        await expect(userMessages(page).last()).toContainText("add tests for login");
      });
      await test.step("recall a slash message without opening its picker, then edit it", async () => {
        await expectComposerDraft(page, "");
        const reply = await session.client.waitForFinish(session.agentId, 15_000);
        expect(reply.status).toBe("idle");
        await expectVisibleAgentSurfacesIdle(page);
        await sendAndWaitForMessage(page, "/tdd", 4);

        const popover = page.getByTestId("composer-autocomplete-popover").filter({ visible: true });
        await pressInComposer(page, "ArrowUp");
        await expectComposerDraft(page, "/tdd");
        await expect(popover).toHaveCount(0);

        await typeIntoFocusedComposer(page, "x");
        await expect(popover.first()).toBeVisible({ timeout: 30_000 });
      });
    } finally {
      await session.cleanup();
    }
  });
});
