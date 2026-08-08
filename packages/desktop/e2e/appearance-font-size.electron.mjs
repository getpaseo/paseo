const SETTINGS_TIMEOUT_MS = 5_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readFontSize(locator) {
  return locator.evaluate((element) => getComputedStyle(element).fontSize);
}

export async function runAppearanceFontSizeRegression(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();

  await page.getByLabel("Theme: System", { exact: true }).click();
  await page.getByText("Pure black", { exact: true }).click();

  const input = page.getByRole("textbox", { name: "Interface font size" });
  const sectionTitle = page.getByText("Theme", { exact: true }).first();
  await input.waitFor({ state: "visible", timeout: SETTINGS_TIMEOUT_MS });

  assert((await input.inputValue()) === "16", "Interface font size did not start at 16px");
  assert(
    (await readFontSize(sectionTitle)) === "12px",
    "Theme label did not start at the default 12px ramp size",
  );

  await input.fill("17");
  await input.press("Tab");

  await page.waitForFunction(
    () => {
      const inputElement = document.querySelector('input[aria-label="Interface font size"]');
      const themeLabel = [...document.querySelectorAll("div")].find(
        (element) => element.children.length === 0 && element.textContent?.trim() === "Theme",
      );
      return (
        inputElement?.value === "17" &&
        themeLabel instanceof HTMLElement &&
        getComputedStyle(themeLabel).fontSize === "13px"
      );
    },
    undefined,
    { timeout: SETTINGS_TIMEOUT_MS },
  );

  await page.getByRole("button", { name: "Back", exact: true }).click();
}
