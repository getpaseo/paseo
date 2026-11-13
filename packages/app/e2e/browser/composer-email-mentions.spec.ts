import { expect, test, type Page } from "../support/fixtures";
import {
  composerLocator,
  expectComposerDraft,
  expectComposerVisible,
  fillComposerDraft,
  enterComposerFullscreen,
  exitComposerFullscreen,
  resizeComposerViewport,
  selectComposerDraftRange,
} from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { expectVisibleAgentSurfacesIdle } from "../support/helpers/agent-stream";

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

test("Enter sends email formats intact and still completes file mentions", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "composer-email-",
    title: "Email mention regression",
    repo: { files: [{ path: "example.com", content: "A file matching the email domain.\n" }] },
  });
  try {
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);
    for (const email of [
      "user <12345+user@noreply.example.com>",
      "alice@example.com",
      "noreply+@example.com",
    ]) {
      await test.step(`complete a file mention, then send ${email} intact`, async () => {
        await selectReadmeMention(page);
        await sendEmailIntact(page, email);
        // Start the next draft only after the daemon and visible agent have settled.
        const reply = await agent.client.waitForFinish(agent.agentId, 15_000);
        expect(reply.status).toBe("idle");
        await expectVisibleAgentSurfacesIdle(page);
      });
    }
  } finally {
    await agent.cleanup();
  }
});

test("fullscreen mention keys edit the draft while inline keys still complete files", async ({
  page,
}) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "composer-fullscreen-mention-",
    title: "Fullscreen mention keys",
  });
  try {
    await resizeComposerViewport(page, "portrait");
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);
    const draft = "First line\nSecond line\n@README";
    await fillComposerDraft(page, draft);
    await expect(fileSuggestions(page).getByText("README.md", { exact: true })).toBeVisible();
    await enterComposerFullscreen(page);
    await expect(fileSuggestions(page)).not.toBeVisible();
    await selectComposerDraftRange(page, draft.length, draft.length);
    await composerLocator(page).press("ArrowUp");
    await expect
      .poll(() =>
        composerLocator(page).evaluate((element) => {
          const input = element as HTMLTextAreaElement;
          return input.selectionStart === input.selectionEnd && input.selectionStart < 23;
        }),
      )
      .toBe(true);
    await selectComposerDraftRange(page, draft.length, draft.length);
    await composerLocator(page).press("Enter");
    await expectComposerDraft(page, `${draft}\n`);
    await exitComposerFullscreen(page);
    await selectReadmeMention(page);
    const commandDraft = "/cl\nSecond line\nThird line";
    await fillComposerDraft(page, commandDraft);
    await selectComposerDraftRange(page, 2, 2);
    await composerLocator(page).press("ArrowRight");
    await expect(fileSuggestions(page).getByText("/clear", { exact: true }).first()).toBeVisible();
    await enterComposerFullscreen(page);
    await expect(fileSuggestions(page)).not.toBeVisible();
    await composerLocator(page).press("Enter");
    await expectComposerDraft(page, "/cl\n\nSecond line\nThird line");
  } finally {
    await agent.cleanup();
  }
});
