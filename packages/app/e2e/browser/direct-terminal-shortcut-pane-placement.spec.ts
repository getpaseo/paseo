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

async function prepareUnfocusedCompactPane(page: Page, workspaceId: string) {
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

async function launchTerminalFromCompactPane(page: Page, pane: Locator) {
  await pane.getByTestId("workspace-tab-switcher-trigger").click();
  await page.getByTestId("workspace-tab-switcher-new-terminal").click();
  await expect(pane.getByTestId("terminal-surface")).toBeVisible({ timeout: 30_000 });
}

async function maximizeAndRestoreCompactPane(page: Page, pane: Locator) {
  await pane.getByTestId("workspace-header-menu-trigger").click();
  await expect(page.getByRole("menuitem", { name: "Split pane right", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Maximize pane", exact: true }).click();
  await pane.getByTestId("workspace-header-menu-trigger").click();
  await page.getByRole("menuitem", { name: "Restore pane", exact: true }).click();
}

test("compact pane launch stays in its owning pane and pane controls remain reachable", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "compact-pane-launch-" });
  try {
    const { originalPane, otherPane } = await prepareUnfocusedCompactPane(
      page,
      workspace.workspaceId,
    );
    await launchTerminalFromCompactPane(page, originalPane);
    await expect(otherPane.getByTestId("workspace-new-tab-panel")).toBeVisible();
    await maximizeAndRestoreCompactPane(page, originalPane);
    await expect(otherPane).toBeVisible();
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

test("compact desktop panes retain window dragging with both sidebars closed", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "compact-pane-window-drag-" });
  try {
    await installLocalDesktopHost(page, workspace.repoPath);
    const { originalPane, otherPane } = await prepareUnfocusedCompactPane(
      page,
      workspace.workspaceId,
    );
    await runWorkspaceActionFromCommandCenter(page, "Toggle left sidebar");
    await expect(originalPane.getByTestId("workspace-tab-switcher-trigger")).toBeVisible();
    await expect(otherPane.getByTestId("workspace-tab-switcher-trigger")).toBeVisible();
    await expectPaneHasWindowDragSurface(originalPane);
    await expectPaneHasWindowDragSurface(otherPane);
  } finally {
    await workspace.cleanup();
  }
});
