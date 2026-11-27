import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  expectFooterActionsInline,
  seedDockedSidebarWidth,
} from "../support/helpers/sidebar-footer-overflow";

// Chromium's pointer bitmasks expose both inputs while the mouse is primary.
test.use({
  viewport: { width: 1280, height: 800 },
  launchOptions: {
    args: [
      "--blink-settings=primaryPointerType=4,availablePointerTypes=6,primaryHoverType=2,availableHoverTypes=3",
    ],
  },
});

test("a touchscreen laptop keeps sidebar actions visible with a fine primary pointer", async ({
  page,
}) => {
  await seedDockedSidebarWidth(page, 200);
  await gotoAppShell(page);
  expect(
    await page.evaluate(() => ({
      finePrimary: matchMedia("(pointer: fine)").matches,
      touchScreen: matchMedia("(any-pointer: coarse)").matches,
    })),
  ).toEqual({ finePrimary: true, touchScreen: true });
  await expectFooterActionsInline(page, [
    "sidebar-add-project",
    "sidebar-usage-icon",
    "sidebar-hosts-trigger",
    "sidebar-help",
    "sidebar-settings",
  ]);
});
