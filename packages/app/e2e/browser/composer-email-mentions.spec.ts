import { expect, test, type Page } from "../support/fixtures";
import {
  composerLocator,
  expectComposerDraft,
  expectComposerVisible,
  fillComposerDraft,
} from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

// The popover has no semantic role; its rows are React Native Pressables.
function fileSuggestions(page: Page) {
  return page.getByTestId("composer-autocomplete-popover");
}

async function selectReadmeMention(page: Page): Promise<void> {
  await fillComposerDraft(page, "@README");
  await expect(fileSuggestions(page).getByText("README.md", { exact: true })).toBeVisible();
  await expect(fileSuggestions(page).getByText("example.com", { exact: true })).toHaveCount(0);
  await composerLocator(page).press("Enter");
  await expectComposerDraft(page, '"README.md"');
}

async function sendEmailIntact(page: Page, email: string): Promise<void> {
  await fillComposerDraft(page, email);
  await expect(fileSuggestions(page)).not.toBeVisible();
  await composerLocator(page).press("Enter");
  await expectComposerDraft(page, "");
  await expect(page.getByText(email, { exact: true })).toBeVisible();
}

for (const email of [
  "user <12345+user@noreply.example.com>",
  "alice@example.com",
  "noreply+@example.com",
]) {
  test(`Enter sends ${email} intact and still completes file mentions`, async ({ page }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "composer-email-",
      title: "Email mention regression",
      repo: { files: [{ path: "example.com", content: "A file matching the email domain.\n" }] },
    });
    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      await test.step("complete a workspace file mention with Enter", async () => {
        await selectReadmeMention(page);
      });
      await test.step("send an email without offering or inserting workspace files", async () => {
        await sendEmailIntact(page, email);
      });
    } finally {
      await agent.cleanup();
    }
  });
}
