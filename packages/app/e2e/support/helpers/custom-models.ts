import { expect, type Locator, type Page } from "@playwright/test";
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
  // Config updates before provider refresh finishes and dismisses the add sheet.
  // Resizing or interacting with the model list must wait for that save to finish.
  await expect(page.getByTestId("add-custom-model-sheet")).toBeHidden();
}

export async function removeCustomModel(page: Page, id: string): Promise<void> {
  await page.getByRole("textbox", { name: "Search models" }).fill(id);
  const remove = page.getByRole("button", { name: `Remove ${id}`, exact: true });
  await expectFullyVisible(remove);
  await remove.click();
  await expect(remove).toHaveCount(0);
}

export async function expectCustomModelRetained(page: Page, id: string): Promise<void> {
  await page.getByRole("textbox", { name: "Search models" }).fill(id);
  await expectFullyVisible(page.getByRole("button", { name: `Remove ${id}`, exact: true }));
}

/**
 * The model list scrolls under the sheet's other sections, so bring the row into view first. A
 * long model id must still leave its Remove button entirely on screen.
 */
async function expectFullyVisible(button: Locator): Promise<void> {
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeInViewport({ ratio: 1 });
}
