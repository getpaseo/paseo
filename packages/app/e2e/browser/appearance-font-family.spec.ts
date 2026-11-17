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

test("renders bundled Geist defaults with Conductor typography metrics", async ({
  page,
}, testInfo) => {
  await openAppearance(page);

  const preview = page.getByRole("img", {
    name: "Live preview of content typography, syntax theme, and code font",
  });
  const content = preview.getByText("Readable content and code preview", { exact: true });
  await expect(content).toHaveCSS("font-size", "16px");
  await expect(content).toHaveCSS("line-height", "26px");
  await expect(content).toHaveCSS("font-family", /Geist/);

  const code = preview.getByText("export", { exact: true }).first();
  await expect(code).toHaveCSS("font-size", "14px");
  await expect(code).toHaveCSS("line-height", "21px");
  await expect(code).toHaveCSS("font-family", /Geist Mono/);
  expect(
    await page.evaluate(() => ({
      ui: document.fonts.check("16px Geist"),
      mono: document.fonts.check('14px "Geist Mono"'),
    })),
  ).toEqual({ ui: true, mono: true });

  await preview.screenshot({ path: testInfo.outputPath("geist-defaults.png") });
});

test("keeps settings usable while editing code and interface font families", async ({
  page,
}, testInfo) => {
  await openAppearance(page);

  for (const name of ["Code font family", "Interface font family"]) {
    await test.step(`reject an unfinished quote in ${name} and restore the default`, async () => {
      await setFontFamily(page, name, "'Fira Code', monospace");
      await expect(page.getByRole("textbox", { name })).toHaveValue("'Fira Code', monospace");

      await setFontFamily(page, name, "'foo");
      await expect(page.getByRole("textbox", { name })).toHaveValue("'Fira Code', monospace");
      await expect(page.getByRole("button", { name: "Appearance", exact: true })).toBeInViewport();
      await expect(page.getByText("Theme", { exact: true }).first()).toHaveCSS("font-size", "12px");

      await page.screenshot({ path: testInfo.outputPath(`rejected-${name}.png`) });
      await page.reload();
      await expect(page.getByRole("textbox", { name })).toHaveValue("'Fira Code', monospace");
      await expect(page.getByRole("button", { name: "Appearance", exact: true })).toBeInViewport();
      await setFontFamily(page, name, "");
      await expect(page.getByRole("textbox", { name })).toHaveValue("");
    });
  }
});

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
