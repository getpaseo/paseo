import { test } from "../support/fixtures";
import { withButtonShowcase } from "../support/helpers/plugin-buttons";

test("plugin header and composer buttons share actions, menus, content, and updates", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await withButtonShowcase(page, async (buttons) => {
    await buttons.verifyObservationLifetime();
    await buttons.openWideMenusAndPopovers();
    await buttons.runAndUpdateActions();
    await buttons.openCompactSheets();
    await buttons.hideAndUnloadOpenButtons();
  });
});
