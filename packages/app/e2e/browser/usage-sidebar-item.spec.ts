import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { openSettingsHostSection } from "../support/helpers/settings";
import { leaveSettings, openSidebarNavSettings } from "../support/helpers/sidebar-nav-settings";
import { installUsageReportsFixture } from "../support/helpers/usage-reports";
import {
  claudeAndCodexReports,
  expectOnUsageScreen,
  expectPinnedUsage,
  leaveUsageScreen,
  openCompactSidebar,
  pinRow,
  showUsageAs,
  togglePin,
  usageItem,
  usageSheet,
} from "../support/helpers/usage-sidebar-item";

const WIDE = { width: 1440, height: 900 };
const COMPACT = { width: 390, height: 844 };

type ScreenshotArea = { kind: "page" } | { kind: "footer" } | { kind: "element"; locator: Locator };

/** Set PASEO_QA_SCREENSHOT_DIR to keep QA screenshots of each state. */
async function qaScreenshot(page: Page, name: string, area: ScreenshotArea = { kind: "page" }) {
  const directory = process.env.PASEO_QA_SCREENSHOT_DIR;
  if (!directory) return;
  // Let sheet and drawer animations settle so the image shows the final state.
  await page.waitForTimeout(600);
  // Expo's fast-refresh indicator sits over the footer's Hosts icon.
  await page.addStyleTag({ content: ".__expo_fast_refresh { display: none !important; }" });
  const file = path.join(directory, `${name}.png`);
  if (area.kind === "element") {
    await area.locator.screenshot({ path: file });
    return;
  }
  const clip = area.kind === "footer" ? await footerClip(page) : undefined;
  await page.screenshot({ path: file, clip });
}

/** Includes summary rows above the fixed icon row. */
async function footerClip(page: Page) {
  return (await page.locator('[data-testid="sidebar-footer"]:visible').boundingBox())!;
}

test.describe("Usage item", () => {
  test("pinned windows show in the sidebar, follow the used/remaining toggle and persist", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const serverId = getServerId();
    await installUsageReportsFixture(page, { lists: [() => claudeAndCodexReports()] });
    await page.setViewportSize(WIDE);
    await gotoAppShell(page);
    const screen = page.getByTestId(`usage-host-${serverId}`);

    await test.step("a fresh device shows default windows, which opens the Usage screen", async () => {
      await expect(usageItem(page)).toBeVisible({ timeout: 30_000 });
      await expectPinnedUsage(page, ["31%", "7%"]);
      await qaScreenshot(page, "desktop-footer-defaults", { kind: "footer" });
      await openSidebarNavSettings(page);
      await qaScreenshot(page, "desktop-settings-sidebar-footer");
      await page.setViewportSize(COMPACT);
      await qaScreenshot(page, "compact-settings-sidebar-footer");
      await gotoAppShell(page);
      await openCompactSidebar(page);
      await expectPinnedUsage(page, ["31%", "7%"]);
      await qaScreenshot(page, "compact-footer-defaults");
      await page.setViewportSize(WIDE);
      await gotoAppShell(page);
      await usageItem(page).click();
      await expectOnUsageScreen(page);
    });

    await test.step("pinning Claude 5-hour and Codex weekly shows both in the Usage item", async () => {
      await expect(screen.getByText("Claude", { exact: true })).toBeVisible({ timeout: 10_000 });
      // One host: no host filter, as on History.
      await expect(page.locator('[data-testid="usage-host-filter-trigger"]:visible')).toHaveCount(
        0,
      );
      await togglePin(screen, "Claude", "Session");
      await expectPinnedUsage(page, ["31%"]);
      await togglePin(screen, "Codex", "Weekly");
      await expectPinnedUsage(page, ["31%", "12%"]);
      await expect(usageItem(page)).not.toHaveText("Usage");
      await qaScreenshot(page, "desktop-footer-pins", { kind: "footer" });
      await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeVisible();
      await qaScreenshot(page, "usage-screen-header", {
        kind: "element",
        locator: page.getByTestId("page-title").locator(".."),
      });
      await qaScreenshot(page, "usage-card-refresh", {
        kind: "element",
        locator: screen.getByTestId("usage-report-claude:default"),
      });
    });

    await test.step("remaining flips the Usage item and the Usage screen", async () => {
      await showUsageAs(page, "remaining");
      await expectPinnedUsage(page, ["69%", "88%"]);
      await expect(usageItem(page)).toHaveAccessibleName(/Claude .*69% left, Codex .*88% left/);
      await expect(
        screen.getByTestId("usage-report-claude:default").getByText("69% left"),
      ).toBeVisible();
      await expect(
        screen.getByTestId("usage-report-codex:default").getByText("88% left"),
      ).toBeVisible();
    });

    await test.step("on desktop the Usage item opens the Usage screen", async () => {
      await gotoAppShell(page);
      await expect(page).not.toHaveURL(/\/usage$/);
      await usageItem(page).click();
      await expectOnUsageScreen(page);
      await expect(page.getByTestId("usage-expanded")).toHaveCount(0);
    });

    await test.step("on a phone the Usage item opens a bottom sheet", async () => {
      await page.setViewportSize(COMPACT);
      await leaveUsageScreen(page);
      await openCompactSidebar(page);
      await expect(usageItem(page)).toBeInViewport();
      await expectPinnedUsage(page, ["69%", "88%"]);
      await qaScreenshot(page, "compact-footer");
      await usageItem(page).click();
      const sheet = usageSheet(page);
      await expect(sheet.getByText("Codex", { exact: true })).toBeInViewport();
      await expect(sheet.getByText("88% left")).toBeVisible();
      await expect(pinRow(sheet, "Claude", "Session")).toBeChecked();
      await expect(pinRow(sheet, "Claude", "Weekly")).not.toBeChecked();
      // The row reads its window, percent and reset; the checkbox state says it is pinned.
      await expect(pinRow(sheet, "Claude", "Session")).toHaveAccessibleName(
        /^Pin Claude Session, \d+% left( · .+)?$/,
      );
      // The sheet carries the Usage screen's controls.
      await expect(page.locator('[data-testid="usage-refresh-all"]:visible')).toBeVisible();
      await expect(page).not.toHaveURL(/\/usage$/);
      const sheetBox = (await sheet.boundingBox())!;
      expect(sheetBox.y).toBeGreaterThan(COMPACT.height / 3);
      expect(sheetBox.width).toBeGreaterThan(COMPACT.width * 0.8);
      await qaScreenshot(page, "compact-sheet");
      await qaScreenshot(page, "phase7-compact-sheet");
      // Tap the backdrop above the sheet.
      await page.mouse.click(COMPACT.width / 2, sheetBox.y / 2);
      await expect(sheet).toHaveCount(0);
      await page.setViewportSize(WIDE);
      await usageItem(page).click();
      await expectOnUsageScreen(page);
    });

    await test.step("a reload keeps the pins and the toggle", async () => {
      await page.reload();
      await expectPinnedUsage(page, ["69%", "88%"]);
      await expect(
        page.locator('[data-testid="usage-display-remaining"]:visible').first(),
      ).toHaveAttribute("aria-selected", "true");
    });

    await test.step("the Settings usage section shares the pins and the toggle", async () => {
      const usageUrl = page.url();
      await openSettings(page);
      await openSettingsHostSection(page, serverId, "usage");
      const section = page.getByTestId("usage-card");
      await expect(section.getByText("69% left")).toBeVisible({ timeout: 10_000 });
      await expect(pinRow(section, "Codex", "Weekly")).toBeChecked();
      await page.goto(usageUrl);
      await expect(screen.getByText("Claude", { exact: true })).toBeVisible({ timeout: 10_000 });
    });

    await test.step("unpinning both brings back default windows, and that survives a reload", async () => {
      await togglePin(screen, "Claude", "Session");
      await togglePin(screen, "Codex", "Weekly");
      await expectPinnedUsage(page, ["69%", "93%"]);
      await page.reload();
      await expect(screen.getByText("88% left")).toBeVisible({ timeout: 10_000 });
      await expectPinnedUsage(page, ["69%", "93%"]);
      await gotoAppShell(page);
      await usageItem(page).click();
      await expectOnUsageScreen(page);
    });

    await test.step("Settings > Sidebar lists the Usage item", async () => {
      await openSidebarNavSettings(page);
      const footer = page.getByTestId("sidebar-nav-section-footer");
      await expect(
        footer.getByTestId("sidebar-nav-item-usage").getByText("Usage", { exact: true }),
      ).toBeVisible();
      await qaScreenshot(page, "settings-sidebar-footer", { kind: "element", locator: footer });
      await leaveSettings(page);
    });
  });
});

test("released hosts supply source logos through the client conversion", async ({ page }) => {
  await installUsageReportsFixture(page, {
    lists: [() => claudeAndCodexReports()],
    providerUsageListOnly: true,
  });
  await page.setViewportSize(WIDE);
  await gotoAppShell(page);
  await expectPinnedUsage(page, ["31%", "7%"]);
  // Source logos are decorative SVGs with no accessible role. Their path data distinguishes
  // the source artwork from the fallback gauge.
  const claudePath = /<path[^>]* d="([^"]+)"/.exec(claudeAndCodexReports()[0]!.icon!)![1]!;
  const codexPath = /<path[^>]* d="([^"]+)"/.exec(claudeAndCodexReports()[1]!.icon!)![1]!;
  const summary = usageItem(page).getByTestId("sidebar-usage-pinned-window");
  await expect(summary.nth(0).locator("svg path").first()).toHaveAttribute("d", claudePath);
  await expect(summary.nth(1).locator("svg path").first()).toHaveAttribute("d", codexPath);
  await qaScreenshot(page, "released-host-footer", { kind: "footer" });
  await usageItem(page).click();
  await expectOnUsageScreen(page);
  const screen = page.getByTestId(`usage-host-${getServerId()}`);
  await expect(
    screen.getByTestId("usage-report-claude").locator("svg path").first(),
  ).toHaveAttribute("d", claudePath);
  await expect(
    screen.getByTestId("usage-report-codex").locator("svg path").first(),
  ).toHaveAttribute("d", codexPath);
  await qaScreenshot(page, "released-host-usage-screen");
});
