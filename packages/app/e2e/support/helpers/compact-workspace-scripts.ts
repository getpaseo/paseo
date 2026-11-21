import { expect, type Locator, type Page } from "@playwright/test";

/** The compact ⋯ sheet. Its trigger shares "Workspace actions" with the sidebar row kebabs. */
export function compactWorkspaceMenu(page: Page): Locator {
  return page.getByTestId("workspace-header-menu-content");
}

export async function openCompactWorkspaceMenu(page: Page): Promise<void> {
  await page.getByTestId("workspace-header-menu-trigger").click();
  await expect(compactWorkspaceMenu(page)).toBeVisible({ timeout: 10_000 });
}

export function menuRow(page: Page, name: string | RegExp): Locator {
  return compactWorkspaceMenu(page).getByRole("menuitem", { name });
}

/** The root row that leads to the Scripts page; its accessible name carries its value. */
export function scriptsMenuRow(page: Page): Locator {
  return menuRow(page, /^Scripts/);
}

/** A row on the Scripts page. A running script's name is followed by "Running". */
export function scriptRow(page: Page, scriptName: string): Locator {
  return menuRow(page, new RegExp(`^${scriptName}`));
}

export async function openScriptsPage(page: Page): Promise<void> {
  await openCompactWorkspaceMenu(page);
  await scriptsMenuRow(page).click();
  await expect(scriptsMenuRow(page)).toHaveCount(0);
  await expect(backButton(page)).toBeVisible();
}

export async function openRunningScriptPage(page: Page, scriptName: string): Promise<void> {
  await openScriptsPage(page);
  await scriptRow(page, scriptName).click();
  await expect(menuRow(page, "Stop")).toBeVisible();
}

/** Taps a stopped script on the Scripts page, which runs it and closes the sheet. */
export async function runScriptFromScriptsPage(page: Page, scriptName: string): Promise<void> {
  await openScriptsPage(page);
  await scriptRow(page, scriptName).click();
  await expect(compactWorkspaceMenu(page)).toBeHidden({ timeout: 10_000 });
}

export async function goBackInMenu(page: Page): Promise<void> {
  await backButton(page).click();
}

export async function closeCompactWorkspaceMenu(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "Bottom sheet backdrop" })
    .first()
    .click({ position: { x: 12, y: 12 } });
  await expect(compactWorkspaceMenu(page)).toBeHidden({ timeout: 10_000 });
}

function backButton(page: Page): Locator {
  return compactWorkspaceMenu(page).getByRole("button", { name: "Back" });
}
