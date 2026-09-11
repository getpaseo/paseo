import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
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

test("touch titles use the space occupied by hidden stats in every grouping", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await gotoAppShell(page);
  await openMobileAgentSidebar(page);
  await expect(workspaceRow(page)).toBeVisible();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath("sidebar.png") });

  await expectTouchTitleWidth(page);
  await workspace.client.setWorkspacePinned(workspace.workspaceId, true);
  await expect(page.getByTestId("sidebar-pinned-section")).toBeVisible();
  await expectTouchTitleWidth(page);
  await workspace.client.setWorkspacePinned(workspace.workspaceId, false);
  await selectSidebarStatusGrouping(page);
  await expectTouchTitleWidth(page);
});

test("desktop hover and shortcut hints preserve title width", async ({ page }, testInfo) => {
  await gotoAppShell(page);
  const row = workspaceRow(page);
  await expect(row).toBeVisible();
  await page.mouse.move(0, 0);
  const initialWidth = await titleWidth(row);
  await expect(row.getByText("+12.3k", { exact: true })).toBeVisible();
  await row.hover();
  await expect(row.getByLabel("Workspace actions", { exact: true })).toBeVisible();
  expect(await titleWidth(row)).toBeCloseTo(initialWidth, 0);
  await page.screenshot({ path: testInfo.outputPath("desktop-hover.png") });
  await page.keyboard.down("Alt");
  await expect(row.getByText("1", { exact: true })).toBeVisible();
  expect(await titleWidth(row)).toBeCloseTo(initialWidth, 0);
  await page.screenshot({ path: testInfo.outputPath("desktop-shortcuts.png") });
  await page.keyboard.up("Alt");
  await expect(row.getByText("1", { exact: true })).toHaveCount(0);
  await toggleTrailing(page, "Diff stats");
  expect(await titleWidth(row)).toBeGreaterThan(initialWidth);
});
