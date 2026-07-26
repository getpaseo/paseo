import { expect, test } from "./fixtures";
import { gotoAppShell, openSettings } from "./helpers/app";
import { openSettingsSection } from "./helpers/settings";

const VALID_THEME = {
  version: 1,
  name: "Warm graphite",
  appearance: "dark",
  colors: {
    background: "#222222",
    foreground: "#dbd7ca",
    raised: "#262626",
    control: "#2b2b2b",
    accent: "#393a34",
    highlight: "#e6cc77",
    mutedForeground: "#a9a397",
    ring: "#777777",
  },
} as const;

async function chooseThemeFile(page: import("@playwright/test").Page, theme: unknown) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import" }).click();
  await (
    await chooser
  ).setFiles({
    name: "theme.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(theme)),
  });
}

test("imports valid custom themes and rejects invalid colors", async ({ page }) => {
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsSection(page, "appearance");

  await chooseThemeFile(page, {
    ...VALID_THEME,
    colors: { ...VALID_THEME.colors, background: "red" },
  });
  await expect(page.getByText("Must be a hex color")).toBeVisible();
  await expect(page.getByText("Import a Paseo theme JSON file")).toBeVisible();

  await chooseThemeFile(page, VALID_THEME);
  await expect(page.getByText("Warm graphite")).toBeVisible();
  await expect(page.getByText("Must be a hex color")).not.toBeVisible();
});
