import { test } from "../support/fixtures";
import { withButtonShowcase } from "../support/helpers/plugin-buttons";

test("plugin header and composer buttons share actions, menus, content, and updates", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await withButtonShowcase(page, testInfo, async (buttons) => {
    await buttons.openWideMenusAndPopovers();
    await buttons.runAndUpdateActions();
    await buttons.openCompactSheets();
    await buttons.hideAndUnloadOpenButtons();
  });
});

test("plugin button observations follow mounted content and error lifetimes", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await withButtonShowcase(page, testInfo, (buttons) => buttons.verifyObservationLifetime());
});
