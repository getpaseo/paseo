import { expect, test } from "../support/fixtures";
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

test("applies the interface font size to settings text", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("@paseo:app-settings", JSON.stringify({ uiFontSize: 24 }));
  });
  await page.goto("/settings");
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await openSettingsSection(page, "appearance");

  const sectionTitle = page.getByText("Theme", { exact: true }).first();
  await expect(sectionTitle).toHaveCSS("font-size", "18px");

  const fontSizeInput = page.getByLabel("Interface font size");
  await expect(fontSizeInput).toHaveValue("24");
  await fontSizeInput.fill("12");
  await fontSizeInput.press("Tab");

  await expect(fontSizeInput).toHaveValue("12");
  await expect(sectionTitle).toHaveCSS("font-size", "9px");
});
