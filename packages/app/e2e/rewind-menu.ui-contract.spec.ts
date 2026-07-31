import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "./fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "./helpers/mock-agent";
import {
  composerLocator,
  expectComposerDraft,
  expectComposerVisible,
  fillComposerDraft,
  submitMessage,
} from "./helpers/composer";

// UI plumbing contract against the dev mock provider. Real-provider behavior is tested in `daemon-e2e/*-rewind.real.e2e.test.ts`.

async function expectUserMessageCount(page: Page, expected: number): Promise<void> {
  await expect(page.getByTestId("user-message")).toHaveCount(expected);
}

function userMessage(page: Page, text: string): Locator {
  return page.getByTestId("user-message").filter({ hasText: text });
}

async function expectUserMessageVisible(page: Page, text: string): Promise<void> {
  await expect(userMessage(page, text)).toBeVisible();
}

test.describe("Rewind sheet", () => {
  test("rewinds from a user message sheet option", async ({ page }) => {
    const firstPrompt = "emit 1 coalesced agent stream updates for first rewind turn.";
    const secondPrompt = "Prepare deleted rewind turn assistant content.";
    const replacementPrompt = "emit 1 coalesced agent stream updates for replacement rewind turn.";
    const session = await seedMockAgentWorkspace({
      repoPrefix: "rewind-e2e-",
      title: "Rewind e2e",
      initialPrompt: firstPrompt,
    });

    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);

      await expectUserMessageVisible(page, firstPrompt);
      await expectUserMessageCount(page, 1);
      await submitMessage(page, secondPrompt);
      await expectUserMessageVisible(page, secondPrompt);
      await expect(page.getByText("Cycle 1", { exact: true })).toBeVisible();
      await expectUserMessageCount(page, 2);

      await userMessage(page, firstPrompt).hover();
      await page.getByTestId("rewind-menu-trigger").first().click();
      const rewindSheet = page.getByTestId("rewind-menu-content");
      await expect(rewindSheet).toBeVisible();
      await expect(
        rewindSheet.getByText("This action cannot be undone", { exact: true }),
      ).toBeVisible();
      await page.getByTestId("rewind-menu-conversation").click();

      await expect(page.getByTestId("rewind-menu-content")).toHaveCount(0);
      await expect(userMessage(page, secondPrompt)).toHaveCount(0);
      await expect(page.getByText("Cycle 1", { exact: true })).toHaveCount(0);
      await expectUserMessageCount(page, 1);
      await expectComposerDraft(page, firstPrompt);

      await submitMessage(page, replacementPrompt);
      await expectUserMessageVisible(page, replacementPrompt);
      await expect(userMessage(page, secondPrompt)).toHaveCount(0);
      await expect(page.getByText("Cycle 1", { exact: true })).toHaveCount(0);
      await expectUserMessageCount(page, 2);

      await fillComposerDraft(page, "");
      await composerLocator(page).evaluate((element) => element.blur());
      await userMessage(page, replacementPrompt).hover();
      await page.getByTestId("rewind-menu-trigger").last().click();
      await expect(page.getByTestId("rewind-menu-content")).toBeVisible();
      await page.getByTestId("rewind-menu-files").click();
      await expect(page.getByTestId("rewind-menu-content")).toHaveCount(0);
      await expectComposerDraft(page, "");
      await expectUserMessageCount(page, 2);

      const preservedDraft = "Keep this human draft after rewind.";
      await fillComposerDraft(page, preservedDraft);
      await composerLocator(page).evaluate((element) => element.blur());
      await userMessage(page, replacementPrompt).hover();
      await page.getByTestId("rewind-menu-trigger").last().click();
      await expect(page.getByTestId("rewind-menu-content")).toBeVisible();
      await page.getByTestId("rewind-menu-files").click();
      await expect(page.getByTestId("rewind-menu-content")).toHaveCount(0);
      await expectComposerDraft(page, preservedDraft);
      await expectUserMessageCount(page, 2);

      await fillComposerDraft(page, "");
      await composerLocator(page).evaluate((element) => element.blur());
      await userMessage(page, replacementPrompt).hover();
      await page.getByTestId("rewind-menu-trigger").last().click();
      await expect(page.getByTestId("rewind-menu-content")).toBeVisible();
      await page.getByTestId("rewind-menu-both").click();
      await expect(page.getByTestId("rewind-menu-content")).toHaveCount(0);
      await expectComposerDraft(page, replacementPrompt);
      await expectUserMessageCount(page, 1);
    } finally {
      await session.cleanup();
    }
  });

  test("surfaces rewind failures without crashing the page", async ({ page }) => {
    const firstPrompt = "emit 1 coalesced agent stream updates for failed rewind turn.";
    const rewindError = "No file checkpoint found for message rewind-failure-e2e.";
    const session = await seedMockAgentWorkspace({
      repoPrefix: "rewind-failure-e2e-",
      title: "Rewind failure e2e",
      initialPrompt: firstPrompt,
      featureValues: {
        mockRewindError: rewindError,
      },
    });

    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);

      await expectUserMessageVisible(page, firstPrompt);

      await userMessage(page, firstPrompt).hover();
      await page.getByTestId("rewind-menu-trigger").first().click();
      const rewindSheet = page.getByTestId("rewind-menu-content");
      await expect(rewindSheet).toBeVisible();
      await expect(
        rewindSheet.getByText("This action cannot be undone", { exact: true }),
      ).toBeVisible();
      await page.getByTestId("rewind-menu-conversation").click();

      await expect(page.getByTestId("app-toast-message")).toHaveText(rewindError);
      await expect(page.getByText("Uncaught Error")).toHaveCount(0);

      await userMessage(page, firstPrompt).hover();
      await page.getByTestId("rewind-menu-trigger").first().click();
      await expect(page.getByTestId("rewind-menu-content")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });
});
