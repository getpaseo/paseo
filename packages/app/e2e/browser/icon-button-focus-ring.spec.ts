import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

const HEADER_ICON_BUTTONS = ["workspace-header-menu-trigger", "workspace-explorer-toggle"];

function visible(page: Page, testId: string): Locator {
  return page.getByTestId(testId).filter({ visible: true }).first();
}

function matchesFocusVisible(target: Locator): Promise<boolean> {
  return target.evaluate((el) => el.matches(":focus-visible"));
}

async function expectKeyboardFocusRing(page: Page, testId: string): Promise<void> {
  const button = visible(page, testId);
  // Chromium matches :focus-visible on a programmatic focus that follows keyboard input.
  await page.keyboard.press("Shift");
  await button.focus();
  await expect(button).toBeFocused();
  expect(await matchesFocusVisible(button)).toBe(true);
  await expect(button).toHaveCSS("outline-style", "solid");
  await expect(button).toHaveCSS("outline-width", "2px");
  // Header rows clip overflow; an outset ring would lose its top and bottom edges.
  await expect(button).toHaveCSS("outline-offset", "-2px");
}

async function expectNoPointerFocusRing(page: Page, testId: string): Promise<void> {
  const button = visible(page, testId);
  await button.blur();
  // Toggle twice so the layout ends where it started.
  await button.click();
  await button.click();
  await expect(button).toBeFocused();
  expect(await matchesFocusVisible(button)).toBe(false);
  await expect(button).toHaveCSS("outline-style", "none");
}

test.describe("Icon button focus ring", () => {
  test("header icon buttons show the focus ring for keyboard focus only", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const workspace = await seedWorkspace({ repoPrefix: "icon-button-focus-" });
    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);
      for (const testId of HEADER_ICON_BUTTONS) {
        await expectKeyboardFocusRing(page, testId);
      }
      await expectNoPointerFocusRing(page, "workspace-explorer-toggle");
    } finally {
      await workspace.cleanup();
    }
  });
});
