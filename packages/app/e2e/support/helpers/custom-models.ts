import { expect, type Page } from "@playwright/test";
import { gotoAppShell, openSettings } from "./app";
import { openSettingsHostSection } from "./settings";
import { getServerId } from "./server-id";

export async function openCustomModels(page: Page): Promise<void> {
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHostSection(page, getServerId(), "providers");
  await page.getByRole("button", { name: "Claude provider details", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Search models" })).toBeVisible();
}

export async function addCustomModel(page: Page, id: string): Promise<void> {
  await page.getByRole("button", { name: "Add model", exact: true }).click();
  await page.getByPlaceholder("e.g. openai/gpt-5").fill(id);
  await page
    .getByTestId("add-custom-model-sheet")
    .getByRole("button", { name: "Add", exact: true })
    .click();
  await expect(page.getByRole("button", { name: `Remove ${id}`, exact: true })).toHaveCount(1);
}

export async function removeCustomModel(page: Page, id: string): Promise<void> {
  await page.getByRole("textbox", { name: "Search models" }).fill(id);
  const remove = page.getByRole("button", { name: `Remove ${id}`, exact: true });
  await expect(remove).toBeInViewport({ ratio: 1 });
  await remove.click();
  await expect(remove).toHaveCount(0);
}

export async function expectCustomModelRetained(page: Page, id: string): Promise<void> {
  await page.getByRole("textbox", { name: "Search models" }).fill(id);
  await expect(page.getByRole("button", { name: `Remove ${id}`, exact: true })).toBeInViewport({
    ratio: 1,
  });
}
