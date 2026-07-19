import { test, expect, type Page } from "./fixtures";
import { buildSettingsSectionRoute } from "@/utils/host-routes";

const APP_SETTINGS_KEY = "@paseo:app-settings";

async function seedDarkTheme(page: Page): Promise<void> {
  await page.addInitScript((settingsKey) => {
    if (localStorage.getItem(settingsKey) === null) {
      localStorage.setItem(settingsKey, JSON.stringify({ theme: "dark" }));
    }
  }, APP_SETTINGS_KEY);
}

async function openAppearance(page: Page): Promise<void> {
  await page.goto(buildSettingsSectionRoute("appearance"));
  await expect(page.getByText("Highlight theme", { exact: true }).first()).toBeVisible();
}

async function selectSolarizedTeal(page: Page): Promise<void> {
  await page.getByLabel("Theme: Dark").click();
  await page.getByRole("button", { name: "Solarized Teal", exact: true }).click();
  await expect(page.getByLabel("Theme: Solarized Teal")).toBeVisible();
}

async function readStoredTheme(page: Page): Promise<string | null> {
  return page.evaluate((settingsKey) => {
    const raw = localStorage.getItem(settingsKey);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { theme?: unknown };
    return typeof parsed.theme === "string" ? parsed.theme : null;
  }, APP_SETTINGS_KEY);
}

test("selects Solarized Teal and preserves it across reload", async ({ page }) => {
  await seedDarkTheme(page);
  await openAppearance(page);

  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await expect(page.getByTestId("settings-detail-pane")).toBeVisible();
  await selectSolarizedTeal(page);

  const sidebar = page.getByTestId("settings-sidebar");
  const appearanceRow = sidebar.getByRole("button", { name: "Appearance", exact: true });
  const themeTrigger = page.getByLabel("Theme: Solarized Teal");
  await expect(sidebar).toHaveCSS("background-color", "rgb(0, 33, 43)");
  await expect(sidebar).toHaveCSS("border-right-color", "rgb(22, 72, 82)");
  await expect(appearanceRow).toHaveCSS("background-color", "rgb(10, 76, 82)");
  await expect(sidebar.getByText("Appearance", { exact: true })).toHaveCSS(
    "color",
    "rgb(201, 214, 211)",
  );
  await expect(themeTrigger).toHaveCSS("border-top-color", "rgb(22, 72, 82)");
  await expect(themeTrigger.getByText("Solarized Teal", { exact: true })).toHaveCSS(
    "color",
    "rgb(201, 214, 211)",
  );

  await expect.poll(() => readStoredTheme(page)).toBe("solarized");

  await page.reload();
  await expect(page.getByLabel("Theme: Solarized Teal")).toBeVisible();
  await expect.poll(() => readStoredTheme(page)).toBe("solarized");
});

test.describe("compact appearance", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("renders Solarized Teal without the desktop settings sidebar", async ({ page }) => {
    await page.addInitScript(
      ({ settingsKey, settings }) => {
        localStorage.setItem(settingsKey, JSON.stringify(settings));
      },
      {
        settingsKey: APP_SETTINGS_KEY,
        settings: { theme: "solarized" },
      },
    );

    await openAppearance(page);

    await expect(page.getByRole("button", { name: "Back", exact: true })).toBeVisible();
    await expect(page.getByText("Appearance", { exact: true }).first()).toBeVisible();
    await expect(page.getByLabel("Theme: Solarized Teal")).toBeVisible();
    await expect(page.getByTestId("settings-sidebar")).not.toBeVisible();
  });
});
