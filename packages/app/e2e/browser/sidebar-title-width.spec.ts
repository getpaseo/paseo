import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import {
  closeSidebarDisplayPreferences,
  openMobileAgentSidebar,
  openSidebarDisplayPage,
  selectSidebarStatusGrouping,
} from "../support/helpers/sidebar";

const TITLE = "Linux desktop sandbox launch support";

async function seedChangedWorkspace() {
  const workspace = await seedWorkspace({
    repoPrefix: "sidebar-title-",
    title: TITLE,
    repo: { withRemote: true },
  });
  try {
    await rm(path.join(workspace.repoPath, "remote.git"), { recursive: true });
    await workspace.client.renameProject(workspace.projectId, "Paseo");
    await writeFile(path.join(workspace.repoPath, "README.md"), "Changed line\n".repeat(12345));
    await workspace.client.checkoutRefresh(workspace.repoPath);
    await expect
      .poll(async () => {
        const { entries } = await workspace.client.fetchWorkspaces();
        return entries.find((entry) => entry.id === workspace.workspaceId)?.diffStat?.additions;
      })
      .toBe(12345);
    return workspace;
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}

function workspaceRow(page: Page) {
  return page.getByRole("button", { name: new RegExp(TITLE) }).filter({ visible: true });
}

async function titleWidth(row: Locator) {
  return row
    .getByText(TITLE, { exact: true })
    .evaluate((element) => element.getBoundingClientRect().width);
}

async function toggleTrailing(page: Page, label: "Diff stats" | "Last activity", touch = false) {
  await openSidebarDisplayPage(page, "sidebar-display-show");
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  if (touch) {
    await page
      .getByRole("button", { name: "Bottom sheet backdrop", exact: true })
      .click({ position: { x: 5, y: 5 } });
    await expect(
      page.getByRole("button", { name: "Bottom sheet backdrop", exact: true }),
    ).toHaveCount(0);
  } else {
    await closeSidebarDisplayPreferences(page);
  }
  await page.mouse.move(0, 0);
}

async function expectTouchTitleWidth(page: Page) {
  const row = workspaceRow(page);
  const withDiff = await titleWidth(row);
  await toggleTrailing(page, "Diff stats", true);
  const withoutStats = await titleWidth(row);
  expect(withDiff).toBeCloseTo(withoutStats, 0);
  await toggleTrailing(page, "Last activity", true);
  expect(await titleWidth(row)).toBeCloseTo(withoutStats, 0);
  await toggleTrailing(page, "Diff stats", true);
}

let workspace: SeededWorkspace;
test.beforeEach(async () => {
  workspace = await seedChangedWorkspace();
});
test.afterEach(async () => {
  await workspace?.cleanup();
});

async function openTouchWorkspaceList(page: Page, testInfo: TestInfo) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await gotoAppShell(page);
  await openMobileAgentSidebar(page);
  await expect(workspaceRow(page)).toBeVisible();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath("sidebar.png") });
}

async function pinWorkspaceForLayout(page: Page) {
  await workspace.client.setWorkspacePinned(workspace.workspaceId, true);
  await expect(page.getByTestId("sidebar-pinned-section")).toBeVisible();
}

async function moveWorkspaceToStatusGrouping(page: Page) {
  await workspace.client.setWorkspacePinned(workspace.workspaceId, false);
  await selectSidebarStatusGrouping(page);
}

async function openDesktopWorkspaceList(page: Page) {
  await gotoAppShell(page);
  const row = workspaceRow(page);
  await expect(row).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(row.getByText("+12.3k", { exact: true })).toBeVisible();
  return titleWidth(row);
}

async function expectHoverKeepsTitleWidth(page: Page, width: number, testInfo: TestInfo) {
  const row = workspaceRow(page);
  await row.hover();
  await expect(row.getByLabel("Workspace actions", { exact: true })).toBeVisible();
  expect(await titleWidth(row)).toBeCloseTo(width, 0);
  await page.screenshot({ path: testInfo.outputPath("desktop-hover.png") });
}

async function expectShortcutHintsKeepTitleWidth(page: Page, width: number, testInfo: TestInfo) {
  const row = workspaceRow(page);
  await page.keyboard.down("Alt");
  await expect(row.getByText("1", { exact: true })).toBeVisible();
  expect(await titleWidth(row)).toBeCloseTo(width, 0);
  await page.screenshot({ path: testInfo.outputPath("desktop-shortcuts.png") });
  await page.keyboard.up("Alt");
  await expect(row.getByText("1", { exact: true })).toHaveCount(0);
}

async function expectDisablingStatsExpandsTitle(page: Page, width: number) {
  await toggleTrailing(page, "Diff stats");
  expect(await titleWidth(workspaceRow(page))).toBeGreaterThan(width);
}

test("touch titles use the space occupied by hidden stats in every grouping", async ({
  page,
}, testInfo) => {
  await openTouchWorkspaceList(page, testInfo);
  await expectTouchTitleWidth(page);
  await pinWorkspaceForLayout(page);
  await expectTouchTitleWidth(page);
  await moveWorkspaceToStatusGrouping(page);
  await expectTouchTitleWidth(page);
});

test("desktop hover and shortcut hints preserve title width", async ({ page }, testInfo) => {
  const width = await openDesktopWorkspaceList(page);
  await expectHoverKeepsTitleWidth(page, width, testInfo);
  await expectShortcutHintsKeepTitleWidth(page, width, testInfo);
  await expectDisablingStatsExpandsTitle(page, width);
});
