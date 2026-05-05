import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";

export async function openProjectSettings(page: Page, projectName: string): Promise<void> {
  await page.getByRole("button", { name: `Edit ${projectName}`, exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Worktree setup commands" })).toBeVisible({
    timeout: 30_000,
  });
}

export async function navigateToProjectSettings(page: Page, projectName: string): Promise<void> {
  await page.getByRole("button", { name: `Edit ${projectName}`, exact: true }).click();
}

export async function clickSaveProjectSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Save project config" }).click();
}

export async function expectProjectSettingsError(
  page: Page,
  kind: "stale" | "invalid" | "write_failed" | "read_failed",
): Promise<void> {
  const testIdMap = {
    stale: "stale-callout",
    invalid: "invalid-callout",
    write_failed: "write-failed-callout",
    read_failed: "read-failed-callout",
  };
  await expect(page.getByTestId(testIdMap[kind])).toBeVisible({ timeout: 15_000 });
}

export async function clickRetryProjectSettingsSave(page: Page): Promise<void> {
  await page.getByTestId("write-failed-callout-action-0").click();
}

export async function clickReloadProjectSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Reload" }).first().click();
}

export async function expectSaveButtonDisabled(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Save project config" })).toBeDisabled();
}

// Counts only the row Views, not the kebab-trigger elements which share the "script-row-"
// testID prefix (those have "-menu-" in their testID).
export async function expectScriptRowCount(page: Page, count: number): Promise<void> {
  await expect(
    page
      .getByTestId("scripts-list")
      .locator('[data-testid^="script-row-"]:not([data-testid*="-menu-"])'),
  ).toHaveCount(count);
}

export async function removeProjectScript(page: Page, scriptName: string): Promise<void> {
  const row = page
    .getByTestId("scripts-list")
    .locator('[data-testid^="script-row-"]:not([data-testid*="-menu-"])')
    .filter({ hasText: scriptName })
    .first();
  // DropdownMenuTrigger renders Pressable without explicit accessibilityRole="button",
  // so find it by its testID prefix instead.
  await row.locator('[data-testid^="script-row-menu-"]').click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Remove" }).click();
}

export async function corruptPaseoConfig(repoPath: string): Promise<void> {
  await writeFile(path.join(repoPath, "paseo.json"), "{not valid json}");
}

export async function bumpPaseoConfigOnDisk(repoPath: string): Promise<void> {
  const configPath = path.join(repoPath, "paseo.json");
  const raw = await readFile(configPath, "utf8");
  const config = JSON.parse(raw) as Record<string, unknown>;
  config._bump = Date.now();
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
}

// The daemon writes atomically via a temp file + rename, so blocking writes requires
// removing write permission from the *directory*, not just the file.
export async function blockPaseoConfigWrites(repoPath: string): Promise<void> {
  await chmod(repoPath, 0o555);
}

export async function unblockPaseoConfigWrites(repoPath: string): Promise<void> {
  await chmod(repoPath, 0o755);
}
