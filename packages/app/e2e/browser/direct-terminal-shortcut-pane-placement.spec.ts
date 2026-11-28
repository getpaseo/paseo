import { installLocalDesktopHost } from "../support/helpers/local-desktop-host";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import {
  clickNewChat,
  gotoWorkspace,
  pressDirectNewTabShortcut,
} from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

test.describe("Direct terminal shortcut pane placement", () => {
  test.use({ viewport: { width: 1600, height: 900 } });
  test("opens a terminal in the focused pane", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "direct-terminal-shortcut-pane-" });

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);
      await clickNewChat(page);

      await runWorkspaceActionFromCommandCenter(page, "Split pane right");
      const focusedPaneChild = page
        .getByTestId("split-group-child")
        .filter({ has: page.getByTestId("workspace-new-tab-panel") });
      const originalPaneChild = page
        .getByTestId("split-group-child")
        .filter({ hasNot: page.getByTestId("workspace-new-tab-panel") });
      await expect(focusedPaneChild).toBeVisible();
      const focusedPaneId = await focusedPaneChild
        .locator('[data-testid^="workspace-pane-"]')
        .getAttribute("data-testid");
      const originalPaneId = await originalPaneChild
        .locator('[data-testid^="workspace-pane-"]')
        .getAttribute("data-testid");
      expect(focusedPaneId).not.toBeNull();
      expect(originalPaneId).not.toBeNull();
      const focusedPane = page.getByTestId(focusedPaneId!);
      const originalPane = page.getByTestId(originalPaneId!);

      await pressDirectNewTabShortcut(page, "t");

      await expect(focusedPane.locator('[data-testid^="workspace-tab-terminal_"]')).toHaveCount(1, {
        timeout: 30_000,
      });
      await expect(originalPane.locator('[data-testid^="workspace-tab-terminal_"]')).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });
});

async function prepareNarrowSplit(page: Page, workspaceId: string) {
  await page.setViewportSize({ width: 1600, height: 900 });
  await gotoWorkspace(page, workspaceId);
  await waitForWorkspaceTabsVisible(page);
  await clickNewChat(page);
  await runWorkspaceActionFromCommandCenter(page, "Split pane right");
  const draftPane = page
    .locator('[data-testid^="workspace-pane-"]')
    .filter({ has: page.getByTestId("message-input-root") });
  const emptyPane = page
    .locator('[data-testid^="workspace-pane-"]')
    .filter({ has: page.getByTestId("workspace-new-tab-panel") });
  const draftPaneId = await draftPane.getAttribute("data-testid");
  const emptyPaneId = await emptyPane.getAttribute("data-testid");
  expect(draftPaneId).not.toBeNull();
  expect(emptyPaneId).not.toBeNull();
  await page.setViewportSize({ width: 760, height: 900 });
  return {
    originalPane: page.getByTestId(draftPaneId!),
    otherPane: page.getByTestId(emptyPaneId!),
  };
}

async function expectPanesKeepTabRails(page: Page, panes: Locator[]) {
  for (const pane of panes) {
    await expect(pane.getByTestId("workspace-tabs-row")).toBeVisible();
  }
  await expect(
    page.getByTestId("workspace-tab-switcher-trigger").filter({ visible: true }),
  ).toHaveCount(0);
}

async function launchTerminalFromPaneRail(page: Page, pane: Locator) {
  await pane.getByTestId("workspace-new-tab-button").click();
  await page.getByTestId("workspace-new-tab-menu-terminal").filter({ visible: true }).click();
  await expect(pane.getByTestId("terminal-surface")).toBeVisible({ timeout: 30_000 });
}

async function maximizeAndRestorePane(pane: Locator) {
  await pane.getByTestId("workspace-maximize-pane").click();
  await pane.getByTestId("workspace-restore-pane").click();
}

test("narrow split panes keep their tab rails and launches stay in the owning pane", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "narrow-split-launch-" });
  try {
    const { originalPane, otherPane } = await prepareNarrowSplit(page, workspace.workspaceId);
    await expectPanesKeepTabRails(page, [originalPane, otherPane]);
    await launchTerminalFromPaneRail(page, originalPane);
    await expect(otherPane.getByTestId("workspace-new-tab-panel")).toBeVisible();
    await maximizeAndRestorePane(originalPane);
    await expect(otherPane).toBeVisible();
    await expectPanesKeepTabRails(page, [originalPane, otherPane]);
  } finally {
    await workspace.cleanup();
  }
});

async function expectPaneHasWindowDragSurface(pane: Locator) {
  await expect
    .poll(() =>
      pane.evaluate((element) =>
        Array.from(element.querySelectorAll<HTMLElement>("div")).some(
          (node) => node.style.getPropertyValue("-webkit-app-region") === "drag",
        ),
      ),
    )
    .toBe(true);
}

test("narrow desktop split panes retain window dragging with both sidebars closed", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "narrow-split-window-drag-" });
  try {
    await installLocalDesktopHost(page, workspace.repoPath);
    const { originalPane, otherPane } = await prepareNarrowSplit(page, workspace.workspaceId);
    await runWorkspaceActionFromCommandCenter(page, "Toggle left sidebar");
    await expectPanesKeepTabRails(page, [originalPane, otherPane]);
    await expectPaneHasWindowDragSurface(originalPane);
    await expectPaneHasWindowDragSurface(otherPane);
  } finally {
    await workspace.cleanup();
  }
});
