import { expect, test } from "../support/fixtures";
import { openAddProjectFlow, addProjectFlow } from "../support/helpers/add-project-flow";
import { installUsageReportsFixture } from "../support/helpers/usage-reports";
import {
  claudeAndCodexReports,
  expectPinnedUsage,
  openCompactSidebar,
} from "../support/helpers/usage-sidebar-item";
import { gotoAppShell } from "../support/helpers/app";
import { SHOWCASE_PLUGIN_ID, installSidebarPlugins } from "../support/helpers/plugin-sidebar-items";
import {
  clickSidebarNavItem,
  expectCompactSidebarHeader,
  expectSidebarNavIconsAlignedWithClose,
  expectSidebarNavRowHighlighted,
  expectStoredSidebarHeaderLayout,
  hoverSidebarNavIcon,
  setSidebarHeaderLayout,
  expectFooterIconRow,
  expectFooterSeparator,
  hoverFooterAddProject,
  footerScreenshot,
  expectFooterItemHidden,
  expectFooterOrder,
  expectFooterSettingsKeys,
  expectSidebarItemHidden,
  expectSidebarNavSettingsOrder,
  expectSidebarNavSettingsRow,
  expectSidebarOrder,
  expectStoredSidebarNav,
  leaveSettings,
  moveFooterItemUp,
  moveSidebarNavItemUp,
  openSidebarNavSettings,
  seedSidebarFooterPreferences,
  seedSidebarNavPreferences,
  setFooterItemVisible,
  setSidebarNavItemVisible,
} from "../support/helpers/sidebar-nav-settings";

test("fixed footer line keeps its five icons, Help and Settings at the end", async ({ page }) => {
  test.setTimeout(120_000);
  await installUsageReportsFixture(page, { lists: [() => claudeAndCodexReports()] });
  await seedSidebarFooterPreferences(page, [
    { key: "add-project", visible: false },
    { key: "usage", visible: true },
  ]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAppShell(page);
  await expectPinnedUsage(page, ["31% 5h", "54% wk", "7% 5h", "12% wk"]);
  await expectFooterIconRow(page);
  await expectFooterSeparator(page, true);
  await footerScreenshot(page, "footer-desktop-with-rows");
  await hoverFooterAddProject(page);
  await footerScreenshot(page, "footer-desktop-add-project-tooltip");
  await openAddProjectFlow(page);
  await page.keyboard.press("Escape");
  await expect(addProjectFlow(page)).toBeHidden();
  await openSidebarNavSettings(page);
  await expectFooterSettingsKeys(page, ["usage"]);
  await setFooterItemVisible(page, "usage", false);
  await leaveSettings(page);
  await expectFooterSeparator(page, false);
  await expectFooterIconRow(page);
  await footerScreenshot(page, "footer-desktop-without-rows");
  await page.setViewportSize({ width: 390, height: 844 });
  await openCompactSidebar(page);
  await expectFooterSeparator(page, false);
  await expectFooterIconRow(page);
  await footerScreenshot(page, "footer-compact-without-rows");
  await page.locator('[data-testid="sidebar-add-project"]:visible').hover();
  await expect(page.getByTestId("sidebar-add-project-tooltip")).toHaveCount(0);
  await footerScreenshot(page, "footer-compact-add-project-hover");
  await openAddProjectFlow(page);
  await page.keyboard.press("Escape");
  await expect(addProjectFlow(page)).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSidebarNavSettings(page);
  await setFooterItemVisible(page, "usage", true);
  await leaveSettings(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openCompactSidebar(page);
  await expectFooterSeparator(page, true);
  await expectFooterIconRow(page);
  await footerScreenshot(page, "footer-compact-with-rows");
});

test.describe("Sidebar items in Appearance settings", () => {
  test("owner switches the sidebar header to the compact layout", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoAppShell(page);

    await test.step("Search moves to the front and the layout switches to compact", async () => {
      await openSidebarNavSettings(page);
      await expect(page.getByTestId("sidebar-header-layout-list")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await moveSidebarNavItemUp(page, "search");
      await moveSidebarNavItemUp(page, "search");
      await setSidebarHeaderLayout(page, "compact");
      await expectStoredSidebarHeaderLayout(page, "compact");
      await page.mouse.move(1200, 800);
      await footerScreenshot(page, "sidebar-header-settings");
      await leaveSettings(page);
    });

    await test.step("Search keeps its row and the other items become icons beside it", async () => {
      await expectCompactSidebarHeader(page, "search", ["new-workspace", "history", "schedules"]);
      await page.mouse.move(1200, 800);
      await footerScreenshot(page, "sidebar-header-compact");
    });

    await test.step("the compact layout holds on a phone-sized sidebar", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openCompactSidebar(page);
      await expectCompactSidebarHeader(page, "search", ["new-workspace", "history", "schedules"]);
      await expectSidebarNavIconsAlignedWithClose(page, ["new-workspace", "history", "schedules"]);
      await footerScreenshot(page, "sidebar-header-compact-mobile");
      await page.setViewportSize({ width: 1440, height: 900 });
    });

    await test.step("an icon names itself on hover and navigates on press", async () => {
      await page.getByTestId("sidebar-search").locator("visible=true").first().hover();
      await expectSidebarNavRowHighlighted(page, "search", true);
      const tooltip = await hoverSidebarNavIcon(page, "history");
      await expect(tooltip.getByText("History", { exact: true })).toBeVisible();
      // The icons sit beside the Search row, so hovering one leaves the row unhighlighted.
      await expectSidebarNavRowHighlighted(page, "search", false);
      await footerScreenshot(page, "sidebar-header-compact-tooltip");
      await clickSidebarNavItem(page, "history");
      await expect(page).toHaveURL(/\/sessions/);
    });

    await test.step("the list layout restores one labelled row per item", async () => {
      await openSidebarNavSettings(page);
      await setSidebarHeaderLayout(page, "list");
      await expectStoredSidebarHeaderLayout(page, "list");
      await leaveSettings(page);
      await expectSidebarOrder(page, ["search", "new-workspace", "history", "schedules"]);
      await page.mouse.move(1200, 800);
      await footerScreenshot(page, "sidebar-header-list");
    });
  });

  test("owner reorders and hides top-level sidebar items", async ({ page }) => {
    await gotoAppShell(page);

    await test.step("the sidebar starts in the default order", async () => {
      await expectSidebarOrder(page, ["new-workspace", "history", "search", "schedules"]);
    });

    await test.step("the Sidebar section lists every item in the same order", async () => {
      await openSidebarNavSettings(page);
      // The section explains itself through the header's info tooltip, not a paragraph.
      await expect(page.getByTestId("sidebar-nav-section-header-info")).toHaveAccessibleName(
        "About Header",
      );
      await expectSidebarNavSettingsOrder(page, [
        "new-workspace",
        "history",
        "search",
        "schedules",
      ]);
      await expectSidebarNavSettingsRow(page, {
        key: "history",
        label: "History",
        visible: true,
      });
      // Items with a keyboard shortcut badge it next to their name. Chords render
      // with Ctrl off macOS, which is what the browser project runs on.
      await expect(
        page.getByTestId("sidebar-nav-item-new-workspace").getByText("Ctrl+N", { exact: true }),
      ).toBeVisible();
    });

    await test.step("moving Schedules up twice lifts it above History", async () => {
      await moveSidebarNavItemUp(page, "schedules");
      await expectSidebarNavSettingsOrder(page, [
        "new-workspace",
        "history",
        "schedules",
        "search",
      ]);
      await moveSidebarNavItemUp(page, "schedules");
      await expectSidebarNavSettingsOrder(page, [
        "new-workspace",
        "schedules",
        "history",
        "search",
      ]);

      await leaveSettings(page);
      await expectSidebarOrder(page, ["new-workspace", "schedules", "history", "search"]);
    });

    await test.step("turning History off removes it from the sidebar", async () => {
      await openSidebarNavSettings(page);
      await setSidebarNavItemVisible(page, "history", false);
      await expectStoredSidebarNav(page, [
        { key: "new-workspace", visible: true },
        { key: "schedules", visible: true },
        { key: "history", visible: false },
        { key: "search", visible: true },
      ]);

      await leaveSettings(page);
      await expectSidebarItemHidden(page, "history");
      await expectSidebarOrder(page, ["new-workspace", "schedules", "search"]);
    });

    await test.step("the sidebar keeps that shape across a reload", async () => {
      await page.reload();
      await expectSidebarItemHidden(page, "history");
      await expectSidebarOrder(page, ["new-workspace", "schedules", "search"]);
    });
  });

  test("renders no top-level items when every one is turned off", async ({ page }) => {
    await seedSidebarNavPreferences(page, [
      { key: "new-workspace", visible: false },
      { key: "history", visible: false },
      { key: "search", visible: false },
      { key: "schedules", visible: false },
    ]);
    await gotoAppShell(page);

    // The sidebar itself still renders; only its top-level nav items are gone.
    await expect(page.locator('[data-testid="sidebar-settings"]:visible')).toBeVisible({
      timeout: 30_000,
    });
    await expectSidebarItemHidden(page, "new-workspace");
    await expectSidebarItemHidden(page, "history");
    await expectSidebarItemHidden(page, "search");
    await expectSidebarItemHidden(page, "schedules");
  });
});

test.describe("Sidebar footer rows in Appearance settings", () => {
  const syncKey = `plugin:${SHOWCASE_PLUGIN_ID}:sync`;
  const brokenKey = `plugin:${SHOWCASE_PLUGIN_ID}:broken`;
  let cleanup: () => Promise<void>;

  test.beforeEach(async () => {
    ({ cleanup } = await installSidebarPlugins());
  });

  test.afterEach(async () => {
    await cleanup();
  });

  test("owner reorders and hides footer rows; the icon row stays fixed", async ({ page }) => {
    test.setTimeout(120_000);
    // The Usage item shows only with summary data.
    await installUsageReportsFixture(page, { lists: [() => claudeAndCodexReports()] });
    // Keys for the fixed footer icon buttons are ignored.
    await seedSidebarFooterPreferences(page, [
      { key: "usage", visible: true },
      { key: "help", visible: false },
      { key: "hosts", visible: false },
      { key: "import", visible: false },
    ]);
    await gotoAppShell(page);

    await test.step("the Footer card lists only the footer rows", async () => {
      await openSidebarNavSettings(page);
      await expect(page.getByTestId("sidebar-nav-section-footer-info")).toHaveAccessibleName(
        "About Footer",
      );
      await expectFooterSettingsKeys(page, ["usage", syncKey, brokenKey]);
      await leaveSettings(page);
      await expectFooterOrder(page, ["usage", syncKey]);
      await expectFooterIconRow(page);
      await expectFooterSeparator(page, true);
    });

    await test.step("moving Sync up and hiding the Usage item changes the rows", async () => {
      await openSidebarNavSettings(page);
      await moveFooterItemUp(page, syncKey);
      await setFooterItemVisible(page, "usage", false);
      await expectFooterSettingsKeys(page, [syncKey, "usage", brokenKey]);
      await leaveSettings(page);
      await expectFooterItemHidden(page, "usage");
      await expect(
        page.locator(`[data-testid="plugin-sidebar-footer-${SHOWCASE_PLUGIN_ID}-sync"]:visible`),
      ).toBeVisible();
      await expectFooterIconRow(page);
      await expectFooterSeparator(page, true);
    });

    await test.step("the rows keep that shape across a reload", async () => {
      await page.reload();
      await expect(
        page.locator(`[data-testid="plugin-sidebar-footer-${SHOWCASE_PLUGIN_ID}-sync"]:visible`),
      ).toBeVisible({ timeout: 30_000 });
      await expectFooterItemHidden(page, "usage");
      await expectFooterIconRow(page);
      await expectFooterSeparator(page, true);
      await openSidebarNavSettings(page);
      await expectFooterSettingsKeys(page, [syncKey, "usage", brokenKey]);
    });
  });
});
