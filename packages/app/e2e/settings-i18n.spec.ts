import { test, expect } from "./fixtures";
import { gotoAppShell, openSettings } from "./helpers/app";
import { openSettingsSection } from "./helpers/settings";

test("Settings language selector switches General labels", async ({ page }) => {
  test.setTimeout(120_000);

  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsSection(page, "general");

  await expect(page.getByText("Default send", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "System", exact: true }).click();
  await page.getByRole("button", { name: "简体中文 - Simplified Chinese", exact: true }).click();

  await expect(page.getByText("默认发送", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "简体中文", exact: true }).click();
  await page.getByRole("button", { name: "English - 英语", exact: true }).click();

  await expect(page.getByText("Default send", { exact: true }).first()).toBeVisible();
});
