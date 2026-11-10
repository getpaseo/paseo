import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

function visible(page: Page, testId: string): Locator {
  return page.getByTestId(testId).filter({ visible: true });
}

function panes(page: Page): Locator {
  return page.locator('[data-testid^="workspace-pane-"]').filter({ visible: true });
}

function splitDividers(page: Page): Locator {
  return visible(page, "workspace-split-resize-handle");
}

async function openSplitWorkspace(
  page: Page,
  repoPrefix: string,
  split: "Split pane right" | "Split pane down",
): Promise<SeededWorkspace> {
  await page.setViewportSize({ width: 1600, height: 900 });
  const workspace = await seedWorkspace({ repoPrefix });
  await gotoWorkspace(page, workspace.workspaceId);
  await waitForWorkspaceTabsVisible(page);
  await clickNewChat(page);
  await expect(visible(page, "workspace-header-title")).toHaveCount(1);
  await runWorkspaceActionFromCommandCenter(page, split);
  await expect(splitDividers(page)).toHaveCount(1);
  await expect(panes(page)).toHaveCount(2);
  return workspace;
}

async function expectOneSharedWorkspaceHeader(page: Page): Promise<void> {
  await expect(visible(page, "workspace-header-title")).toHaveCount(1);
  await expect(visible(page, "workspace-header-menu-trigger")).toHaveCount(1);
  await expect(panes(page).getByTestId("workspace-header-title")).toHaveCount(0);
  await expect(panes(page).getByTestId("workspace-header-menu-trigger")).toHaveCount(0);
}

/** The tab counter belongs to the single-pane layout: split panes always show their rails. */
async function expectPanesKeepTabRails(page: Page): Promise<void> {
  for (const pane of await panes(page).all()) {
    await expect(pane.getByTestId("workspace-tabs-row")).toBeVisible();
  }
  await expect(visible(page, "workspace-tab-switcher-trigger")).toHaveCount(0);
}

async function dragDivider(divider: Locator, deltaX: number): Promise<void> {
  const page = divider.page();
  const box = await divider.boundingBox();
  if (!box) throw new Error("Divider has no bounding box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX, y, { steps: 8 });
  await page.mouse.up();
}

test.describe("Workspace header with split panes", () => {
  test("wide side-by-side panes share one header and keep their tab rails", async ({ page }) => {
    const workspace = await openSplitWorkspace(page, "split-header-wide-", "Split pane right");
    try {
      await expectOneSharedWorkspaceHeader(page);
      await expectPanesKeepTabRails(page);
    } finally {
      await workspace.cleanup();
    }
  });

  test("stacked panes share one header", async ({ page }) => {
    const workspace = await openSplitWorkspace(page, "split-header-stacked-", "Split pane down");
    try {
      await expectOneSharedWorkspaceHeader(page);
      await expectPanesKeepTabRails(page);
    } finally {
      await workspace.cleanup();
    }
  });

  test("a narrow workspace shows one compact header and every pane keeps its tab rail", async ({
    page,
  }) => {
    const workspace = await openSplitWorkspace(page, "split-header-narrow-", "Split pane right");
    try {
      await page.setViewportSize({ width: 760, height: 900 });
      await expectPanesKeepTabRails(page);
      await expectOneSharedWorkspaceHeader(page);
    } finally {
      await workspace.cleanup();
    }
  });

  test("a narrow pane beside a wide one keeps its tab rail", async ({ page }) => {
    const workspace = await openSplitWorkspace(page, "split-header-mixed-", "Split pane right");
    try {
      await dragDivider(splitDividers(page), -300);
      const [left, right] = await panes(page).all();
      const leftBox = await left.boundingBox();
      const rightBox = await right.boundingBox();
      expect(leftBox!.width).toBeLessThan(500);
      expect(rightBox!.width).toBeGreaterThan(500);
      await expectPanesKeepTabRails(page);
      await expectOneSharedWorkspaceHeader(page);
    } finally {
      await workspace.cleanup();
    }
  });

  test("closing back to one pane returns the merged compact header", async ({ page }) => {
    const workspace = await openSplitWorkspace(page, "split-header-close-", "Split pane right");
    try {
      const [, emptyPane] = await panes(page).all();
      const emptyPaneRail = emptyPane.getByTestId("workspace-tabs-row");
      await emptyPaneRail.locator('[data-testid^="workspace-tab-"]').first().hover();
      await emptyPaneRail.locator('[data-testid*="-close-"]').first().click();
      await expect(splitDividers(page)).toHaveCount(0);
      await expect(visible(page, "workspace-header-title")).toHaveCount(1);
      await page.setViewportSize({ width: 760, height: 900 });
      await expect(visible(page, "workspace-tabs-row")).toHaveCount(0);
      await expect(visible(page, "workspace-tab-switcher-trigger")).toHaveCount(1);
      await expect(visible(page, "workspace-header-title")).toHaveCount(1);
    } finally {
      await workspace.cleanup();
    }
  });
});
