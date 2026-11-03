import { verifyPluginToolTranslations } from "../support/helpers/plugin-translations";
import { test } from "../support/fixtures";
import { withButtonShowcase } from "../support/helpers/plugin-buttons";

test("plugin header and composer buttons share actions, menus, content, and updates", async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  await withButtonShowcase(page, info, async (buttons) => {
    await buttons.verifyObservationLifetime();
    await buttons.openWideMenusAndPopovers();
    await buttons.runAndUpdateActions();
    await buttons.openCompactSheets();
    await buttons.useCompactWorkspaceMenu();
    await buttons.hideAndUnloadOpenButtons();
  });
});

test("a plugin popover opens once after History opens a plugin screen", async ({ page }, info) => {
  test.setTimeout(180_000);
  await withButtonShowcase(page, info, async (buttons) => {
    await buttons.openPopoverAfterAppWideHop();
  });
});

test("plugin tooltips and menu labels follow app language with a panel draft open", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  await verifyPluginToolTranslations(page, info);
});
