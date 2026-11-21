import { expect, test } from "../support/fixtures";
import { addProjectFlow } from "../support/helpers/add-project-flow";
import { gotoAppShell } from "../support/helpers/app";
import {
  chooseFooterOverflowAction,
  expectFooterLine,
  expectFooterMenusInsideViewport,
  expectFooterNeverClipped,
  expectFooterOverflowActions,
  footerOverflowMenu,
  openFooterOverflow,
  seedDockedSidebarWidth,
  watchFooterClipping,
} from "../support/helpers/sidebar-footer-overflow";
import { addOfflineHostsAndReload } from "../support/helpers/hosts";
import { openCompactSidebar } from "../support/helpers/usage-sidebar-item";

const TOUCH_CONTROL = 44;
const MIN_SIDEBAR_WIDTH = 200;
const ALL_INLINE = [
  "sidebar-add-project",
  "sidebar-usage-icon",
  "sidebar-hosts-trigger",
  "sidebar-help",
  "sidebar-settings",
];
// Five 44pt buttons and the row's padding need 236pt; 200pt holds three and the caret.
const NARROW_TOUCH_LINE = [
  "sidebar-add-project",
  "sidebar-hosts-trigger",
  "sidebar-footer-overflow",
  "sidebar-settings",
];

test.describe("Sidebar footer on a touch screen", () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: true });

  test("a narrow docked sidebar moves the actions it can't fit behind a caret", async ({
    page,
  }) => {
    await seedDockedSidebarWidth(page, MIN_SIDEBAR_WIDTH);
    await watchFooterClipping(page);
    await gotoAppShell(page);
    await expectFooterLine(page, { testIDs: NARROW_TOUCH_LINE, controlSize: TOUCH_CONTROL });
    await expectFooterNeverClipped(page);

    await test.step("Help opens as a page of the overflow menu", async () => {
      await openFooterOverflow(page);
      await expectFooterOverflowActions(page, ["Usage", "Help and support"]);
      await chooseFooterOverflowAction(page, "Help and support");
      await expect(page.getByRole("menuitem", { name: "What's new" })).toBeVisible();
      await expect(page.getByTestId("sidebar-help-menu")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(footerOverflowMenu(page)).toBeHidden();
    });

    await test.step("Usage opens from the overflow menu", async () => {
      await openFooterOverflow(page);
      await chooseFooterOverflowAction(page, "Usage");
      await expect(footerOverflowMenu(page)).toBeHidden();
      await expect(page.getByTestId("usage-modal")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("usage-modal")).toBeHidden();
    });

    await test.step("Add project and Settings shortcuts still work", async () => {
      await page.keyboard.press("Control+o");
      await expect(addProjectFlow(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(addProjectFlow(page)).toBeHidden();
      await page.keyboard.press("Control+,");
      await expect(page).toHaveURL(/\/settings\/general$/);
    });
  });

  test("the default sidebar width keeps all five actions inline", async ({ page }) => {
    await gotoAppShell(page);
    await expectFooterLine(page, { testIDs: ALL_INLINE, controlSize: TOUCH_CONTROL });
  });
});

test.describe("Sidebar footer in a compact overlay narrower than the footer", () => {
  test.use({ viewport: { width: 220, height: 800 }, hasTouch: true });

  test("the overflow menu reaches the hidden actions", async ({ page }) => {
    await watchFooterClipping(page);
    await gotoAppShell(page);
    await openCompactSidebar(page);
    await expectFooterLine(page, { testIDs: NARROW_TOUCH_LINE, controlSize: TOUCH_CONTROL });
    await expectFooterNeverClipped(page);
    await openFooterOverflow(page);
    await expectFooterOverflowActions(page, ["Usage", "Help and support"]);
    await expectFooterMenusInsideViewport(page);
  });
});

test.describe("Sidebar footer on a short, narrow phone", () => {
  // 164pt for buttons holds Settings, Add project and the caret, so Hosts moves behind it.
  test.use({ viewport: { width: 180, height: 360 }, hasTouch: true });

  test("the overflow Hosts page scrolls to its last host and Add host", async ({ page }) => {
    await gotoAppShell(page);
    await addOfflineHostsAndReload(
      page,
      Array.from({ length: 10 }, (_, index) => ({
        serverId: `overflow-host-${index}`,
        label: `Overflow host ${index}`,
      })),
    );
    await openCompactSidebar(page);
    await expectFooterLine(page, {
      testIDs: ["sidebar-add-project", "sidebar-footer-overflow", "sidebar-settings"],
      controlSize: TOUCH_CONTROL,
    });
    await openFooterOverflow(page);
    await expectFooterOverflowActions(page, ["Usage", "Hosts", "Help and support"]);
    await expectFooterMenusInsideViewport(page);
    await chooseFooterOverflowAction(page, "Hosts");
    await expectFooterMenusInsideViewport(page);
    const addHost = page.getByRole("menuitem", { name: "Add host" });
    await addHost.scrollIntoViewIfNeeded();
    await expect(page.getByRole("menuitem", { name: "Overflow host 9" })).toBeVisible();
    await expect(addHost).toBeInViewport();
    await addHost.click();
    await expect(page.getByText("Add connection", { exact: true })).toBeVisible();
  });
});
