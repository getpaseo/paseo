import { test, expect } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { clickSettingsBackToWorkspace, openSettingsSection } from "../support/helpers/settings";

test("Settings language selector switches General labels", async ({ page }) => {
  test.setTimeout(120_000);

  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsSection(page, "general");

  await expect(page.getByText("Language", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "System", exact: true }).click();
  await page.getByRole("menuitem", { name: "简体中文 - Simplified Chinese", exact: true }).click();

  await expect(page.getByText("语言", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "简体中文", exact: true }).click();
  await page.getByRole("menuitem", { name: "English - 英语", exact: true }).click();

  await expect(page.getByText("Language", { exact: true }).first()).toBeVisible();
});

test("Settings language selector switches to Korean", async ({ page }) => {
  test.setTimeout(120_000);

  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsSection(page, "general");

  await page.getByRole("button", { name: "System", exact: true }).click();
  await page.getByRole("menuitem", { name: "한국어 - Korean", exact: true }).click();

  await expect(page.getByText("언어", { exact: true }).first()).toBeVisible();

  await page.getByTestId("settings-host-section-agents").click();
  await expect(
    page
      .getByTestId("host-page-inject-mcp-card")
      .getByText("에이전트가 워크트리, 에이전트, 예약 작업을 관리할 수 있습니다", { exact: true }),
  ).toBeVisible();

  await clickSettingsBackToWorkspace(page);
  await expect(
    page.getByTestId("sidebar-schedules").getByText("예약", { exact: true }),
  ).toBeVisible();

  await openSettings(page);
  await page.getByRole("button", { name: "한국어", exact: true }).click();
  await page.getByRole("menuitem", { name: "English - 영어", exact: true }).click();

  await expect(page.getByText("Language", { exact: true }).first()).toBeVisible();
});
