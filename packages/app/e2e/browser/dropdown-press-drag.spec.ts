import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { gotoAppShell } from "../support/helpers/app";
import { seedModelProvider } from "../support/helpers/agent-profiles";
import { openGlobalNewWorkspaceComposer } from "../support/helpers/new-workspace";

async function moveTo(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  if (!box) throw new Error("Dropdown target has no bounds");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

test("held clicks select sidebar submenu and custom model rows", async ({ page }) => {
  test.setTimeout(120_000);
  const workspace = await seedWorkspace({ repoPrefix: "dropdown-drag-" });
  const provider = await seedModelProvider({
    id: "drag-models",
    label: "Drag Models",
    models: [
      { id: "first", label: "First model", description: "Test choice" },
      { id: "second", label: "Second model", description: "Test choice" },
    ],
  });
  try {
    await gotoAppShell(page);
    const trigger = page.getByTestId("sidebar-display-preferences-menu");
    await moveTo(page, trigger);
    await page.mouse.down();
    await expect(page.getByTestId("sidebar-display-preferences-content")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("menu-held.png") });
    await moveTo(page, page.getByTestId("sidebar-display-grouping"));
    const status = page.getByTestId("sidebar-grouping-status");
    await moveTo(page, status);
    await page.screenshot({ path: test.info().outputPath("submenu-hovered.png") });
    await page.mouse.up();
    await expect(page.getByTestId("sidebar-display-preferences-content")).toBeHidden();
    await trigger.click();
    await expect(page.getByTestId("sidebar-display-grouping")).toContainText("Status");
    await page.keyboard.press("Escape");
    await openGlobalNewWorkspaceComposer(page);
    const modelTrigger = page.getByTestId("combined-model-selector").filter({ visible: true });
    await moveTo(page, modelTrigger);
    await page.mouse.down();
    const picker = page.getByTestId("combobox-desktop-container");
    await expect(picker).toBeVisible();
    await page.mouse.up();
    await picker.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByTestId("model-provider-drag-models").click();
    const first = page.getByTestId("model-row-drag-models-first");
    await expect(first).toBeVisible();
    await first.click();
    await moveTo(page, modelTrigger);
    const modelTooltip = page.getByText("Change model", { exact: true });
    // Let the previous tooltip's exit animation finish before checking the new one.
    await expect(modelTooltip).toHaveCount(1);
    await expect(modelTooltip).toBeVisible();
    await page.mouse.down();
    await expect(picker).toBeVisible();
    await expect(modelTooltip).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("model-held.png") });
    await moveTo(page, page.getByTestId("model-row-drag-models-second"));
    await page.screenshot({ path: test.info().outputPath("model-hovered.png") });
    await page.mouse.up();
    await expect(picker).toBeHidden();
    await expect(modelTrigger).toContainText("Second model");
    await page.screenshot({ path: test.info().outputPath("model-selected.png") });
  } finally {
    await page.mouse.up();
    await provider.restore();
    await workspace.cleanup();
  }
});
