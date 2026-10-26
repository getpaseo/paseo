import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import {
  BOTS_PLUGIN_ID,
  COMPACT,
  LEGACY_PLUGIN_ID,
  SHOWCASE_PLUGIN_ID,
  WIDE,
  closeScreen,
  expectRowActive,
  footerItem,
  headerRow,
  installSidebarPlugins,
  popoverBox,
  runCommand,
  visibleTestId,
} from "../support/helpers/plugin-sidebar-items";
import {
  leaveSettings,
  openSidebarNavSettings,
  seedSidebarFooterPreferences,
  setFooterItemVisible,
} from "../support/helpers/sidebar-nav-settings";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { installUsageReportsFixture } from "../support/helpers/usage-reports";
import { claudeAndCodexReports } from "../support/helpers/usage-sidebar-item";

const APP_SETTINGS_KEY = "@paseo:app-settings";

/** Set PASEO_QA_SCREENSHOT_DIR to keep QA screenshots of each state. */
async function qaScreenshot(page: Page, name: string, area?: Locator) {
  const directory = process.env.PASEO_QA_SCREENSHOT_DIR;
  if (!directory) return;
  // Let popover, sheet and drawer animations settle so the image shows the final state.
  await page.waitForTimeout(600);
  // Expo's fast-refresh indicator sits over the footer's Hosts icon.
  await page.addStyleTag({ content: ".__expo_fast_refresh { display: none !important; }" });
  const file = path.join(directory, `${name}.png`);
  if (area) await area.screenshot({ path: file });
  else await page.screenshot({ path: file });
}

/** Footer rows sit above the fixed bottom line, spanning it from Add project to Settings. */
async function expectFooterRow(page: Page, row: Locator) {
  // Polled: on compact the drawer is still sliding in when the row first shows.
  await expect
    .poll(async () => {
      const addProject = (await visibleTestId(page, "sidebar-add-project").boundingBox())!;
      const settings = (await visibleTestId(page, "sidebar-settings").boundingBox())!;
      const box = (await row.boundingBox())!;
      return {
        aboveBottomLine: box.y + box.height <= addProject.y,
        alignedLeft: Math.abs(box.x - addProject.x) < 1,
        alignedRight: Math.abs(box.x + box.width - (settings.x + settings.width)) < 1,
      };
    })
    .toEqual({ aboveBottomLine: true, alignedLeft: true, alignedRight: true });
}

function botRow(page: Page, rowId: string): Locator {
  return headerRow(page, BOTS_PLUGIN_ID, `bots-${rowId}`);
}

async function boxOf(locator: Locator) {
  const result = await locator.boundingBox();
  expect(result).not.toBeNull();
  return result!;
}

/** The open screen's header title; a pushed screen keeps the one below it mounted. */
function screenTitle(page: Page): Locator {
  return page.locator('[data-testid="plugin-surface-title"]:visible').last();
}

async function expectBotScreen(page: Page, botId: string) {
  await expect(page).toHaveURL(
    new RegExp(`/plugin/${BOTS_PLUGIN_ID}/surface/bot\\?param\\.botId=${botId}$`),
  );
  await expect(page.getByText(`Bot screen: ${botId}`, { exact: true })).toBeVisible();
  // The plugin titles the screen from its params: the bot's name.
  await expect(screenTitle(page)).toHaveText(botId === "bot-1" ? "Bot 1" : "Bot 2");
  await expectRowActive(botRow(page, "bot-1"), botId === "bot-1");
  await expectRowActive(botRow(page, "bot-2"), botId === "bot-2");
  await expectRowActive(botRow(page, "status"), false);
}

/** The popover opens to the right of `row`, level with it, and away from `elsewhere`. */
async function expectPopoverBeside(page: Page, text: string, row: Locator, elsewhere: Locator) {
  const popover = await popoverBox(page, text);
  const rowBox = await boxOf(row);
  const otherBox = await boxOf(elsewhere);
  expect(popover.x).toBeGreaterThanOrEqual(rowBox.x + rowBox.width);
  expect(Math.abs(popover.y - rowBox.y)).toBeLessThan(40);
  expect(Math.abs(popover.y - otherBox.y)).toBeGreaterThan(20);
}

/** Subscription ids the daemon confirms released, collected from the page's websocket. */
function trackReleasedSubscriptions(page: Page): Set<string> {
  const released = new Set<string>();
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => collectRelease(released, payload)),
  );
  return released;
}

function collectRelease(released: Set<string>, payload: string | Buffer) {
  if (typeof payload !== "string") return;
  const frame = JSON.parse(payload);
  if (frame.message?.type === "subscription.release.response")
    released.add(frame.message.payload.subscriptionId);
}

async function expectReleased(released: Set<string>, subscriptionId: string) {
  await expect.poll(() => released.has(subscriptionId)).toBe(true);
}

function readAlertsObservation(page: Page): Promise<string | null> {
  return page.evaluate(
    () => (globalThis as { __botAlertsObservation?: string }).__botAlertsObservation ?? null,
  );
}

/** The id of the observation the Bot alerts item opened after `previous`. */
async function nextAlertsObservation(page: Page, previous: string | null): Promise<string> {
  await expect.poll(() => readAlertsObservation(page)).not.toBe(previous);
  return (await readAlertsObservation(page))!;
}

function sidebarFooter(page: Page): Locator {
  return visibleTestId(page, "sidebar-add-project").locator("xpath=..");
}

test.describe("Plugin sidebar items", () => {
  let workspaceId: string;
  let cleanup: () => Promise<void>;

  test.beforeEach(async () => {
    const workspace = await seedWorkspace({ repoPrefix: "plugin-sidebar-items-" });
    const plugins = await installSidebarPlugins();
    workspaceId = workspace.workspaceId;
    cleanup = async () => {
      await plugins.cleanup();
      await workspace.cleanup();
    };
  });

  test.afterEach(async () => {
    await cleanup();
  });

  test("a plugin's screen, header row, footer popover and command work together", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    // The Usage item shows only with summary data, once it is turned on.
    await installUsageReportsFixture(page, { lists: [() => claudeAndCodexReports()] });
    await seedSidebarFooterPreferences(page, [{ key: "usage", visible: true }]);
    await page.setViewportSize(WIDE);
    await gotoWorkspace(page, workspaceId);
    const row = headerRow(page, SHOWCASE_PLUGIN_ID, "deploys");
    const sync = footerItem(page, SHOWCASE_PLUGIN_ID, "sync");
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(sync).toBeVisible();

    await test.step("a throwing item renders nothing and leaves the sidebar working", async () => {
      await expect(visibleTestId(page, `plugin-sidebar-${SHOWCASE_PLUGIN_ID}-broken`)).toHaveCount(
        0,
      );
      await expect(footerItem(page, SHOWCASE_PLUGIN_ID, "broken")).toHaveCount(0);
      await expect(page.getByText("Plugin failed", { exact: false })).toHaveCount(0);
      await expect(visibleTestId(page, "sidebar-settings")).toBeVisible();
    });

    await test.step("the header row highlights while its screen is open", async () => {
      await expectRowActive(row, false);
      await row.click();
      await expect(page).toHaveURL(new RegExp(`/plugin/${SHOWCASE_PLUGIN_ID}/surface/deploys`));
      await expect(page.getByText("Deploys screen body", { exact: true })).toBeVisible();
      await expect(screenTitle(page)).toHaveText("Deploys");
      await expectRowActive(row, true);
      await qaScreenshot(page, "phase2-desktop-sidebar-screen");
      await closeScreen(page);
      await expectRowActive(row, false);
    });

    await test.step("the trailing button presses on its own", async () => {
      await page.getByRole("button", { name: "Refresh deploys", exact: true }).click();
      await expect(row).toHaveAccessibleName("Deploys (refreshed 1)");
      await expect(page).not.toHaveURL(/\/plugin\//);
      await expect(page.getByText("Deploys screen body", { exact: true })).toHaveCount(0);
    });

    await test.step("the footer row renders as a row above the bottom line", async () => {
      await expect(sync).toHaveAccessibleName("Sync");
      await expectFooterRow(page, sync);
      await expect(visibleTestId(page, "sidebar-usage")).toBeVisible();
      await qaScreenshot(page, "phase5-desktop-footer", sidebarFooter(page));
    });

    await test.step("the footer row opens a popover anchored to it", async () => {
      await sync.click();
      const popover = await popoverBox(page);
      const button = (await sync.boundingBox())!;
      await expect(page.getByText("Presentation: wide", { exact: true })).toBeVisible();
      expect(popover.y + popover.height).toBeLessThanOrEqual(button.y);
      expect(button.y - popover.y).toBeLessThan(300);
      expect(Math.abs(popover.x - button.x)).toBeLessThan(80);
      await qaScreenshot(page, "phase2-desktop-popover");
      await page.getByRole("button", { name: "Open deploys from popover", exact: true }).click();
      await expect(page.getByText("Deploys screen body", { exact: true })).toBeVisible();
      await expect(page.getByText("Sync details", { exact: true })).toHaveCount(0);
      await closeScreen(page);
    });

    await test.step("the command center item opens the screen", async () => {
      await runCommand(page, "Open deploys");
      await expect(page.getByText("Deploys screen body", { exact: true })).toBeVisible();
      await expectRowActive(row, true);
      await closeScreen(page);
    });

    await test.step("on a compact layout the popover is a bottom sheet", async () => {
      await page.setViewportSize(COMPACT);
      await page.getByRole("button", { name: "Open menu", exact: true }).first().click();
      const compactSync = footerItem(page, SHOWCASE_PLUGIN_ID, "sync");
      await expect(compactSync).toBeInViewport();
      await expectFooterRow(page, compactSync);
      await expect(headerRow(page, SHOWCASE_PLUGIN_ID, "deploys")).toBeInViewport();
      await qaScreenshot(page, "phase2-compact-sidebar");
      await qaScreenshot(page, "phase5-compact-footer", sidebarFooter(page));
      await compactSync.click();
      await expect(page.getByText("Presentation: compact", { exact: true })).toBeVisible();
      const sheet = await popoverBox(page);
      expect(sheet.y).toBeGreaterThan(COMPACT.height / 2);
      await qaScreenshot(page, "phase2-compact-sheet");
      await page.getByRole("button", { name: "Close sync details", exact: true }).click();
      await expect(page.getByText("Sync details", { exact: true })).toHaveCount(0);
    });
  });

  test("a header row's shortcut hint presses the row", async ({ page }) => {
    await page.setViewportSize(WIDE);
    await gotoWorkspace(page, workspaceId);
    const newWorkspace = visibleTestId(page, "sidebar-global-new-workspace");
    await expect(newWorkspace).toBeVisible({ timeout: 30_000 });
    await newWorkspace.hover();
    const hint = page.getByText("Ctrl+N", { exact: true }).locator("visible=true");
    await expect(hint).toBeVisible();
    await qaScreenshot(page, "phase7-header-row-hint", newWorkspace.locator("xpath=../.."));
    await hint.click();
    await expect(page).toHaveURL(/\/new(\?|$)/);
  });

  test("a legacy plugin keeps its row, icon, order and visibility", async ({ page }) => {
    test.setTimeout(180_000);
    await page.addInitScript(
      ({ key, sidebarNavItems }) => localStorage.setItem(key, JSON.stringify({ sidebarNavItems })),
      {
        key: APP_SETTINGS_KEY,
        sidebarNavItems: [
          { key: `plugin:${LEGACY_PLUGIN_ID}:entry`, visible: true },
          { key: "new-workspace", visible: true },
          { key: `plugin:${LEGACY_PLUGIN_ID}:hidden`, visible: false },
        ],
      },
    );
    await page.setViewportSize(WIDE);
    await gotoWorkspace(page, workspaceId);
    const entry = headerRow(page, LEGACY_PLUGIN_ID, "entry");
    await expect(entry).toBeVisible({ timeout: 30_000 });
    let entryIcon = "";

    await test.step("the saved order and visibility still apply", async () => {
      await expect(entry).toHaveAccessibleName("Legacy entry");
      await expect(entry.locator("svg")).toHaveCount(1);
      entryIcon = await entry.locator("svg").innerHTML();
      await expect(headerRow(page, LEGACY_PLUGIN_ID, "hidden")).toHaveCount(0);
      const entryBox = (await entry.boundingBox())!;
      const newWorkspaceBox = (await visibleTestId(
        page,
        "sidebar-global-new-workspace",
      ).boundingBox())!;
      expect(entryBox.y).toBeLessThan(newWorkspaceBox.y);
    });

    await test.step("the row opens its surface on its own sidebar route and highlights", async () => {
      await entry.click();
      await expect(page).toHaveURL(new RegExp(`/plugin/${LEGACY_PLUGIN_ID}/sidebar/entry$`));
      await expect(page.getByText("Legacy screen body", { exact: true })).toBeVisible();
      await expect(page.getByTestId("plugin-surface-close")).toBeVisible();
      await expect(screenTitle(page)).toHaveText("Legacy entry");
      await expectRowActive(entry, true);
      await closeScreen(page);
    });

    await test.step("remembered sidebar routes keep resolving", async () => {
      await page.goto(
        `/h/${encodeURIComponent(getServerId())}/plugin/${LEGACY_PLUGIN_ID}/sidebar/entry`,
      );
      await expect(page.getByText("Legacy screen body", { exact: true })).toBeVisible();
      await expectRowActive(headerRow(page, LEGACY_PLUGIN_ID, "entry"), true);
    });

    await test.step("links saved before a plugin moved to addScreen open the same-id screen", async () => {
      const host = encodeURIComponent(getServerId());
      await page.goto(`/h/${host}/plugin/${BOTS_PLUGIN_ID}/sidebar/bot?param.botId=bot-2`);
      await expect(page.getByText("Bot screen: bot-2", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(screenTitle(page)).toHaveText("Bot 2");
      await page.goto(`/h/${host}/plugin/${BOTS_PLUGIN_ID}/bot`);
      await expect(page).toHaveURL(new RegExp(`/plugin/${BOTS_PLUGIN_ID}/sidebar/bot$`));
      await expect(screenTitle(page)).toHaveText("Bot");
    });

    await test.step("settings shows a legacy row's own icon and one generic icon for the rest", async () => {
      await openSidebarNavSettings(page);
      const legacyIcon = page
        .getByTestId(`sidebar-nav-item-plugin:${LEGACY_PLUGIN_ID}:entry`)
        .locator("svg")
        .first();
      const showcaseIcon = page
        .getByTestId(`sidebar-nav-item-plugin:${SHOWCASE_PLUGIN_ID}:deploys`)
        .locator("svg")
        .first();
      const footerIcon = page
        .getByTestId("sidebar-nav-section-footer")
        .getByTestId(`sidebar-nav-item-plugin:${SHOWCASE_PLUGIN_ID}:sync`)
        .locator("svg")
        .first();
      const markup = await showcaseIcon.innerHTML();
      expect(await footerIcon.innerHTML()).toBe(markup);
      expect(await legacyIcon.innerHTML()).not.toBe(markup);
      // The same registered icon the sidebar row draws.
      expect(await legacyIcon.innerHTML()).toBe(entryIcon);
      await qaScreenshot(page, "phase2-desktop-settings-sidebar");
      await qaScreenshot(
        page,
        "phase5-settings-sidebar-footer",
        page.getByTestId("sidebar-nav-section-footer"),
      );
      await page.setViewportSize(COMPACT);
      await expect(page.getByTestId("sidebar-nav-section-footer").first()).toBeAttached();
      await qaScreenshot(page, "phase2-compact-settings-sidebar");
    });
  });
  test("one item renders a group of rows, and each row opens its own screen params", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(WIDE);
    await gotoWorkspace(page, workspaceId);
    const bot1 = botRow(page, "bot-1");
    const bot2 = botRow(page, "bot-2");
    const status = botRow(page, "status");
    await expect(bot1).toBeVisible({ timeout: 30_000 });

    await test.step("the rows and the separator render in order in the header", async () => {
      await expect(bot1).toHaveAccessibleName("Bot 1");
      await expect(bot2).toHaveAccessibleName("Bot 2");
      await expect(status).toHaveAccessibleName("Bot status");
      const [first, second, third] = [await boxOf(bot1), await boxOf(bot2), await boxOf(status)];
      expect(second.y).toBeGreaterThan(first.y);
      // The separator adds its line and margins between Bot 2 and the status row.
      expect(third.y - (second.y + second.height)).toBeGreaterThan(8);
      expect(second.y - (first.y + first.height)).toBeLessThan(4);
    });

    await test.step("pressing Bot 2 opens the bot screen and highlights only its row", async () => {
      await bot2.click();
      await expectBotScreen(page, "bot-2");
      await qaScreenshot(page, "phase6-desktop-sidebar-bots");
    });

    await test.step("a reload keeps the screen and its params", async () => {
      await page.reload();
      await expectBotScreen(page, "bot-2");
      await qaScreenshot(page, "phase6-bot-screen");
    });

    await test.step("Bot 1 replaces Bot 2 on the same screen, and back returns to Bot 2", async () => {
      await bot1.click();
      await expectBotScreen(page, "bot-1");
      await page.goBack();
      await expectBotScreen(page, "bot-2");
    });

    await test.step("a popover opened from a later row anchors to that row", async () => {
      await status.click();
      await expectPopoverBeside(page, "Bot status details", status, bot1);
      await page.getByRole("button", { name: "Close bot status", exact: true }).click();
      await expect(page.getByText("Bot status details", { exact: true })).toHaveCount(0);
    });

    await test.step("a trailing button's popover anchors to its own row, not the last pressed", async () => {
      await page.getByRole("button", { name: "More for Bot 2", exact: true }).click();
      await expectPopoverBeside(page, "Bot 2 options", bot2, status);
      await qaScreenshot(page, "phase6-desktop-popover-row");
      await page.getByRole("button", { name: "Close Bot 2 options", exact: true }).click();
      await expect(page.getByText("Bot 2 options", { exact: true })).toHaveCount(0);
    });

    await test.step("a param named like a route segment reaches the screen", async () => {
      await runCommand(page, "Open bot 3 on server x");
      await expect(page.getByText("Bot screen: bot-3", { exact: true })).toBeVisible();
      await expect(page.getByText("serverId param: x", { exact: true })).toBeVisible();
      // No bot named bot-3, so the title function returns its own fallback.
      await expect(screenTitle(page)).toHaveText("Bot");
      await page.reload();
      await expect(page.getByText("serverId param: x", { exact: true })).toBeVisible();
    });

    await test.step("Settings lists the group as one item", async () => {
      await openSidebarNavSettings(page);
      const header = page.getByTestId("sidebar-nav-section-header");
      await expect(
        header.getByTestId(`sidebar-nav-item-plugin:${BOTS_PLUGIN_ID}:bots`),
      ).toHaveCount(1);
      await expect(header.getByText("Bots", { exact: true })).toHaveCount(1);
      await expect(header.getByText("Bot 1", { exact: true })).toHaveCount(0);
      await leaveSettings(page);
    });

    await test.step("the compact sidebar shows the same group", async () => {
      await page.setViewportSize(COMPACT);
      await page.getByRole("button", { name: "Open menu", exact: true }).first().click();
      await expect(botRow(page, "bot-1")).toBeInViewport();
      await expect(botRow(page, "status")).toBeInViewport();
      await qaScreenshot(page, "phase6-compact-sidebar-bots");
    });
  });

  test("a plugin adds and removes a footer item after setup", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(WIDE);
    await gotoWorkspace(page, workspaceId);
    await expect(botRow(page, "bot-1")).toBeVisible({ timeout: 30_000 });
    const alerts = footerItem(page, BOTS_PLUGIN_ID, "alerts");
    await expect(alerts).toHaveCount(0);

    await runCommand(page, "Add bot alerts");
    await expect(alerts).toBeVisible();
    await expect(alerts).toHaveAccessibleName("Bot alerts");
    await expectFooterRow(page, alerts);

    await runCommand(page, "Remove bot alerts");
    await expect(alerts).toHaveCount(0);
  });

  test("a sidebar item's observations close when it is hidden or removed", async ({ page }) => {
    test.setTimeout(120_000);
    const released = trackReleasedSubscriptions(page);
    const alerts = footerItem(page, BOTS_PLUGIN_ID, "alerts");
    await page.setViewportSize(WIDE);
    await gotoWorkspace(page, workspaceId);
    await expect(botRow(page, "bot-1")).toBeVisible({ timeout: 30_000 });

    await runCommand(page, "Add bot alerts");
    await expect(alerts).toBeVisible();
    const first = await nextAlertsObservation(page, null);
    expect(released.has(first)).toBe(false);

    await test.step("hiding the item in Settings closes its observation", async () => {
      await openSidebarNavSettings(page);
      await setFooterItemVisible(page, `plugin:${BOTS_PLUGIN_ID}:alerts`, false);
      await expectReleased(released, first);
      await setFooterItemVisible(page, `plugin:${BOTS_PLUGIN_ID}:alerts`, true);
      await leaveSettings(page);
    });

    await test.step("removing the item through its remover closes its observation", async () => {
      await expect(alerts).toBeVisible();
      const second = await nextAlertsObservation(page, first);
      expect(released.has(second)).toBe(false);
      await runCommand(page, "Remove bot alerts");
      await expect(alerts).toHaveCount(0);
      await expectReleased(released, second);
    });
  });
});
