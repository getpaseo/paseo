import { expect, test } from "../support/fixtures";
import type { Page } from "@playwright/test";
import { openSettingsSection } from "../support/helpers/settings";

async function openAppearance(page: Page) {
  await page.goto("/settings");
  await openSettingsSection(page, "appearance");
}

async function setFontFamily(page: Page, name: string, family: string) {
  const input = page.getByRole("textbox", { name });
  await input.fill(family);
  await input.press("Tab");
}

for (const name of ["Code font family", "Interface font family"]) {
  test(`keeps settings usable after an unfinished quote in ${name}`, async ({ page }, testInfo) => {
    await openAppearance(page);
    await setFontFamily(page, name, "'Fira Code', monospace");
    await expect(page.getByRole("textbox", { name })).toHaveValue("'Fira Code', monospace");

    await setFontFamily(page, name, "'foo");
    await expect(page.getByRole("textbox", { name })).toHaveValue("'Fira Code', monospace");
    await expect(page.getByRole("button", { name: "Appearance", exact: true })).toBeInViewport();
    await expect(page.getByText("Theme", { exact: true }).first()).toHaveCSS("font-size", "12px");

    await page.screenshot({ path: testInfo.outputPath("rejected-font.png") });
    await page.reload();
    await expect(page.getByRole("textbox", { name })).toHaveValue("'Fira Code', monospace");
    await expect(page.getByRole("button", { name: "Appearance", exact: true })).toBeInViewport();
    await setFontFamily(page, name, "");
    await expect(page.getByRole("textbox", { name })).toHaveValue("");
  });
}

test("opens settings with defaults when a malformed font was already saved", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "@paseo:app-settings",
      JSON.stringify({ monoFontFamily: "'foo", uiFontFamily: '"foo' }),
    );
  });
  await openAppearance(page);
  await expect(page.getByRole("textbox", { name: "Code font family" })).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "Interface font family" })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Appearance", exact: true })).toBeInViewport();
  await expect(page.getByText("Theme", { exact: true }).first()).toHaveCSS("font-size", "12px");
});
