import { expect, test } from "./fixtures";
import { gotoHome } from "./helpers/app";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("working directory combobox keeps search open after selecting a directory", async ({ page }) => {
  await gotoHome(page);

  const workingDirectorySelect = page
    .locator('[data-testid="working-directory-select"]:visible')
    .first();
  await expect(workingDirectorySelect).toBeVisible();
  await workingDirectorySelect.click({ force: true });

  const searchInput = page.getByRole("textbox", { name: /search directories/i }).first();
  await expect(searchInput).toBeVisible();

  const firstQuery = `/tmp/paseo-continue-search-${Date.now()}-a`;
  await searchInput.fill(firstQuery);

  const firstOption = page.getByText(new RegExp(`^${escapeRegex(firstQuery)}$`)).first();
  await expect(firstOption).toBeVisible();
  await firstOption.click({ force: true });

  await expect(searchInput).toBeVisible();
  await expect(searchInput).toHaveValue(firstQuery);

  const secondQuery = `${firstQuery}-b`;
  await searchInput.fill(secondQuery);
  const secondOption = page.getByText(new RegExp(`^${escapeRegex(secondQuery)}$`)).first();
  await expect(secondOption).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(searchInput).not.toBeVisible();
});
