import { test, expect } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { openSettingsSection } from "../support/helpers/settings";
import { seedWorkspace } from "../support/helpers/seed-client";

test("Settings language selector switches General labels", async ({ page }) => {
  test.setTimeout(120_000);

  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsSection(page, "general");

  await expect(page.getByText("Default send", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "System", exact: true }).click();
  await page.getByRole("menuitem", { name: "简体中文 - Simplified Chinese", exact: true }).click();

  await expect(page.getByText("默认发送", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "简体中文", exact: true }).click();
  await page.getByRole("menuitem", { name: "English - 英语", exact: true }).click();

  await expect(page.getByText("Default send", { exact: true }).first()).toBeVisible();
});

test("Settings language selector switches to Korean", async ({ page }) => {
  test.setTimeout(120_000);

  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsSection(page, "general");

  await page.getByRole("button", { name: "System", exact: true }).click();
  await page.getByRole("menuitem", { name: "한국어 - Korean", exact: true }).click();

  await expect(page.getByText("기본 전송", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "한국어", exact: true }).click();
  await page.getByRole("menuitem", { name: "English - 영어", exact: true }).click();

  await expect(page.getByText("Default send", { exact: true }).first()).toBeVisible();
});

test("Settings language selector translates the sidebar Workspaces header to French", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const workspace = await seedWorkspace({ repoPrefix: "settings-i18n-fr-" });

  try {
    await gotoAppShell(page);
    const workspacesTitle = page.getByTestId("sidebar-workspaces-section-title");
    await expect(workspacesTitle).toHaveText("Workspaces", { timeout: 30_000 });

    await openSettings(page);
    await openSettingsSection(page, "general");
    await page.getByRole("button", { name: "System", exact: true }).click();
    await page.getByRole("menuitem", { name: "Français - French", exact: true }).click();
    await expect(page.getByText("Envoi par défaut", { exact: true }).first()).toBeVisible();

    await gotoAppShell(page);
    await expect(workspacesTitle).toHaveText("Espaces de travail", { timeout: 30_000 });
    await expect(page.getByLabel("Préférences d’affichage", { exact: true })).toBeVisible();
  } finally {
    await workspace.cleanup();
  }
});
