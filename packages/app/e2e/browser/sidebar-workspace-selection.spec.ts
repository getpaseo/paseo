import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { seedWorkspace } from "../support/helpers/seed-client";
import { selectSidebarStatusGrouping } from "../support/helpers/sidebar";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

// Cmd on macOS, Ctrl on Windows and Linux: the platform primary modifier the app binds as `mod`.
const MOD = "ControlOrMeta";

type SeededProject = Awaited<ReturnType<typeof seedWorkspace>>;

async function seedProjectWithWorkspaces(count: number) {
  const project = await seedWorkspace({ repoPrefix: "sidebar-selection-" });
  const workspaceIds = [project.workspaceId];
  for (let index = 1; index < count; index += 1) {
    const created = await project.client.createWorkspace({
      source: { kind: "directory", path: project.repoPath, projectId: project.projectId },
      title: `Selection workspace ${index}`,
    });
    if (!created.workspace) throw new Error(created.error ?? "Failed to seed a workspace");
    workspaceIds.push(created.workspace.id);
  }
  return { project, workspaceIds };
}

/** The seeded rows, in the order the sidebar shows them. */
async function rowsInSidebarOrder(page: Page, workspaceIds: readonly string[]) {
  const testIds = workspaceIds.map((id) => `sidebar-workspace-row-${getServerId()}:${id}`);
  const rows = page.locator(testIds.map((testId) => `[data-testid="${testId}"]`).join(", "));
  await expect(rows).toHaveCount(workspaceIds.length);
  const ordered = await rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-testid") ?? ""),
  );
  return ordered.map((testId) => page.getByTestId(testId));
}

async function expectChecked(rows: readonly Locator[], checked: readonly boolean[]) {
  for (const [index, row] of rows.entries()) {
    await expect(row).toHaveAttribute("aria-checked", String(checked[index]));
  }
}

async function expectSelectedCount(page: Page, count: number) {
  await expect(page.getByTestId("workspace-selection-count")).toHaveText(`${count} selected`);
}

async function exitSelection(page: Page) {
  await page.getByTestId("workspace-selection-exit").click();
  await expect(page.getByTestId("workspace-selection-toast")).toHaveCount(0);
}

/**
 * Walks the Finder click matrix on four rows, starting with the first row open: a modifier click
 * from normal mode selects only the clicked row, Cmd/Ctrl+click toggles, Shift+click extends and
 * shrinks a range from the anchor, and plain clicks keep toggling while select mode is on.
 */
async function exerciseClickMatrix(page: Page, rows: readonly Locator[]) {
  const [first, second, third, fourth] = rows;
  await first.click();
  await expect(first).toHaveAttribute("aria-selected", "true");
  const openWorkspaceUrl = page.url();

  await third.click({ modifiers: [MOD] });
  await expectSelectedCount(page, 1);
  await expectChecked(rows, [false, false, true, false]);

  await fourth.click({ modifiers: [MOD] });
  await expectChecked(rows, [false, false, true, true]);
  await third.click({ modifiers: [MOD] });
  await expectChecked(rows, [false, false, false, true]);

  await second.click();
  await expectChecked(rows, [false, true, false, true]);
  expect(page.url()).toBe(openWorkspaceUrl);
  await exitSelection(page);

  await second.click({ modifiers: ["Shift"] });
  await expectSelectedCount(page, 1);
  await expectChecked(rows, [false, true, false, false]);

  await fourth.click({ modifiers: ["Shift"] });
  await expectChecked(rows, [false, true, true, true]);
  await third.click({ modifiers: ["Shift"] });
  await expectChecked(rows, [false, true, true, false]);
  await first.click({ modifiers: ["Shift"] });
  await expectChecked(rows, [true, true, false, false]);

  await fourth.click({ modifiers: [MOD] });
  await third.click({ modifiers: ["Shift"] });
  await expectChecked(rows, [true, true, true, true]);
  expect(page.url()).toBe(openWorkspaceUrl);
  await exitSelection(page);
}

test.describe("sidebar workspace selection clicks", () => {
  let seeded: { project: SeededProject; workspaceIds: string[] } | null = null;

  test.afterEach(async () => {
    await seeded?.project.cleanup();
    seeded = null;
  });

  test("Cmd/Ctrl+click and Shift+click select like Finder in project grouping", async ({
    page,
  }) => {
    seeded = await seedProjectWithWorkspaces(4);
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await exerciseClickMatrix(page, await rowsInSidebarOrder(page, seeded.workspaceIds));
  });

  test("Cmd/Ctrl+click and Shift+click select like Finder in status grouping", async ({ page }) => {
    seeded = await seedProjectWithWorkspaces(4);
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await selectSidebarStatusGrouping(page);
    await exerciseClickMatrix(page, await rowsInSidebarOrder(page, seeded.workspaceIds));
  });
});
