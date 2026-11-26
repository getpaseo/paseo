import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { openSettingsSection } from "../support/helpers/settings";

async function setExplorerDefaultWidth(page: Page, width: number): Promise<void> {
  await page.goto("/settings");
  await openSettingsSection(page, "appearance");
  const input = page.getByRole("textbox", { name: "Explorer sidebar width" });
  await input.fill(String(width));
  await input.press("Tab");
  await expect(input).toHaveValue(String(width));
}

async function expectExplorerWidth(page: Page, width: number): Promise<void> {
  // Workspaces visited earlier stay mounted with their own Explorer; measure the visible one.
  const explorer = page.getByTestId("workspace-explorer-sidebar").filter({ visible: true });
  if (!(await explorer.isVisible())) {
    await page.getByTestId("workspace-explorer-toggle").filter({ visible: true }).first().click();
  }
  await expect(explorer).toBeVisible();
  await expect.poll(async () => (await explorer.boundingBox())?.width).toBeCloseTo(width, 0);
}

async function dragExplorerEdge(page: Page, distance: number): Promise<void> {
  const handle = page
    .getByTestId("workspace-explorer-sidebar-resize-handle")
    .filter({ visible: true })
    .getByRole("separator");
  const bounds = await handle.boundingBox();
  if (!bounds) throw new Error("Explorer resize handle is missing");
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + 100;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + distance, y, { steps: 10 });
  await page.mouse.up();
}

test("Explorer opens at the default width setting unless the workspace was resized", async ({
  page,
  withWorkspace,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const resized = await withWorkspace();
  const untouched = await withWorkspace();

  await resized.navigateTo();
  await expectExplorerWidth(page, 320);

  await setExplorerDefaultWidth(page, 480);
  await page.screenshot({ path: testInfo.outputPath("settings-explorer-width.png") });
  await resized.navigateTo();
  await expectExplorerWidth(page, 480);
  await page.screenshot({ path: testInfo.outputPath("explorer-at-default-width.png") });

  await dragExplorerEdge(page, -100);
  await expectExplorerWidth(page, 580);

  await untouched.navigateTo();
  await expectExplorerWidth(page, 480);

  await setExplorerDefaultWidth(page, 400);
  await untouched.navigateTo();
  await expectExplorerWidth(page, 400);
  await resized.navigateTo();
  await expectExplorerWidth(page, 580);

  await page.reload();
  await expectExplorerWidth(page, 580);
});
