import { expect, test } from "./fixtures";
import { openSettingsSection } from "./helpers/settings";

test("shows AMOLED and Catppuccin themes in the appearance picker", async ({ page }, testInfo) => {
  await page.goto("/settings");
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await openSettingsSection(page, "appearance");

  const themeTrigger = page.getByLabel("Theme: System", { exact: true });
  await themeTrigger.click();
  await expect(page.getByText("AMOLED", { exact: true })).toBeVisible();
  const mochaOption = page.getByText("Catppuccin Mocha", { exact: true });
  await expect(mochaOption).toBeVisible();
  await expect(mochaOption).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: testInfo.outputPath("appearance-theme-picker.png"),
    fullPage: true,
  });
});
