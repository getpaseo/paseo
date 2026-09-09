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
