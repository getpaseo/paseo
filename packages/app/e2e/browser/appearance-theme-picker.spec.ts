import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { openSettingsSection } from "../support/helpers/settings";

test("shows Pure black in the appearance picker", async ({ page }, testInfo) => {
  await page.goto("/settings");
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await openSettingsSection(page, "appearance");

  const themeTrigger = page.getByLabel("Theme: System", { exact: true });
  await themeTrigger.click();
  await expect(page.getByText("Pure black", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("appearance-theme-picker.png"),
    fullPage: true,
  });
});

test("keeps the selected workspace visible in Pure black", async ({ page }, testInfo) => {
  const workspace = await seedWorkspace({
    repoPrefix: "pure-black-selected-workspace-",
    title: "Selected workspace",
  });

  try {
    await page.addInitScript(() => {
      localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: "pureBlack" }));
    });
    await gotoAppShell(page);

    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();

    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(row).toHaveCSS("background-color", "rgb(17, 17, 17)");
    await page.screenshot({
      path: testInfo.outputPath("pure-black-selected-workspace.png"),
      fullPage: true,
    });
  } finally {
    await workspace.cleanup();
  }
});

test("applies the interface font size to settings text", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("@paseo:app-settings", JSON.stringify({ uiBaseFontSize: 21 }));
  });
  await page.goto("/settings");
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await openSettingsSection(page, "appearance");

  const sectionTitle = page.getByText("Theme", { exact: true }).first();
  await expect(sectionTitle).toHaveCSS("font-size", "18px");

  const interfaceSizeInput = page.getByLabel("Interface font size");
  const contentSizeInput = page.getByLabel("Content font size");
  await expect(interfaceSizeInput).toHaveValue("21");
  await expect(contentSizeInput).toHaveValue("21");
  await interfaceSizeInput.fill("12");
  await interfaceSizeInput.press("Tab");

  await expect(interfaceSizeInput).toHaveValue("12");
  await expect(contentSizeInput).toHaveValue("21");
  await expect(sectionTitle).toHaveCSS("font-size", "10px");
});
