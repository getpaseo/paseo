import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { openSettings } from "./app";
import { clickSettingsBackToWorkspace, openSettingsSection } from "./settings";

const APP_SETTINGS_KEY = "@paseo:app-settings";

/** Persisted nav key -> the testID the app shell renders that item with. */
const SHELL_ROW_TEST_IDS = {
  "new-workspace": "sidebar-global-new-workspace",
  history: "sidebar-sessions",
  search: "sidebar-search",
  schedules: "sidebar-schedules",
} as const;

export type SidebarNavKey = keyof typeof SHELL_ROW_TEST_IDS;

export interface SidebarNavPreference {
  key: string;
  visible: boolean;
}

function shellRow(page: Page, key: SidebarNavKey): Locator {
  // `:visible` rather than a plain testID: the shell keeps a compact copy of the
  // sidebar mounted, so the pinned row is the first visible match.
  return page.locator(`[data-testid="${SHELL_ROW_TEST_IDS[key]}"]:visible`).first();
}

function settingsRow(page: Page, key: SidebarNavKey): Locator {
  return page.getByTestId(`sidebar-nav-item-${key}`);
}

function itemLabel(key: SidebarNavKey): string {
  return {
    "new-workspace": "New workspace",
    history: "History",
    search: "Search",
    schedules: "Schedules",
  }[key];
}

async function rowTop(locator: Locator): Promise<number | null> {
  const box = await locator.boundingBox();
  return box?.y ?? null;
}

export async function seedSidebarNavPreferences(
  page: Page,
  preferences: SidebarNavPreference[],
): Promise<void> {
  await page.addInitScript(
    ({ key, sidebarNavItems }) => {
      localStorage.setItem(key, JSON.stringify({ sidebarNavItems }));
    },
    { key: APP_SETTINGS_KEY, sidebarNavItems: preferences },
  );
}

/** Seeds stored footer rows once; a reload keeps whatever the app wrote since. */
export async function seedSidebarFooterPreferences(
  page: Page,
  preferences: SidebarNavPreference[],
): Promise<void> {
  await page.addInitScript(
    ({ key, sidebarFooterItems }) => {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, JSON.stringify({ sidebarFooterItems }));
    },
    { key: APP_SETTINGS_KEY, sidebarFooterItems: preferences },
  );
}

export async function openSidebarNavSettings(page: Page): Promise<void> {
  await openSettings(page);
  await openSettingsSection(page, "sidebar");
  await expect(page.getByTestId("sidebar-nav-section-header")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("sidebar-nav-section-footer")).toBeVisible();
}

export async function leaveSettings(page: Page): Promise<void> {
  await clickSettingsBackToWorkspace(page);
}

export async function moveSidebarNavItemUp(page: Page, key: SidebarNavKey): Promise<void> {
  await settingsRow(page, key).getByRole("button", { name: "Move up", exact: true }).click();
}

export async function setSidebarNavItemVisible(
  page: Page,
  key: SidebarNavKey,
  visible: boolean,
): Promise<void> {
  const toggle = settingsRow(page, key).getByRole("switch", {
    name: itemLabel(key),
    exact: true,
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(visible));
}

export async function expectSidebarNavSettingsRow(
  page: Page,
  expected: { key: SidebarNavKey; label: string; visible: boolean },
): Promise<void> {
  const row = settingsRow(page, expected.key);
  await expect(row).toBeVisible();
  await expect(row.getByText(expected.label, { exact: true })).toBeVisible();
  const toggle = row.getByRole("switch", { name: expected.label, exact: true });
  await expect(toggle).toHaveAccessibleName(expected.label);
  await expect(toggle).toHaveAttribute("aria-checked", String(expected.visible));
}

export async function expectSidebarNavSettingsOrder(
  page: Page,
  keys: SidebarNavKey[],
): Promise<void> {
  await expectVerticalOrder(keys, (key) => settingsRow(page, key), "sidebar nav settings rows");
}

export async function expectSidebarOrder(page: Page, keys: SidebarNavKey[]): Promise<void> {
  await expectVerticalOrder(keys, (key) => shellRow(page, key), "app shell sidebar rows");
}

export async function expectSidebarItemHidden(page: Page, key: SidebarNavKey): Promise<void> {
  await expect(page.locator(`[data-testid="${SHELL_ROW_TEST_IDS[key]}"]:visible`)).toHaveCount(0);
}

export async function expectStoredSidebarNav(
  page: Page,
  expected: SidebarNavPreference[],
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((key) => {
          const raw = localStorage.getItem(key);
          return raw ? (JSON.parse(raw).sidebarNavItems ?? null) : null;
        }, APP_SETTINGS_KEY),
      { timeout: 15_000 },
    )
    .toEqual(expected);
}

async function expectVerticalOrder<Key extends string>(
  keys: Key[],
  locate: (key: Key) => Locator,
  subject: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const measured = await Promise.all(
          keys.map(async (key) => ({ key, top: await rowTop(locate(key)) })),
        );
        if (!measured.every((entry): entry is { key: Key; top: number } => entry.top !== null))
          return null;
        return measured.sort((a, b) => a.top - b.top).map((entry) => entry.key);
      },
      { message: `Expected ${subject} in order`, timeout: 15_000 },
    )
    .toEqual(keys);
}

/** Persisted footer row key -> the testID the app shell renders that row with. */
function shellFooterTestID(key: string): string {
  if (key === "usage") return "sidebar-usage";
  const [, pluginId, itemId] = key.split(":");
  return `plugin-sidebar-footer-${pluginId}-${itemId}`;
}

function shellFooterRow(page: Page, key: string): Locator {
  return page.locator(`[data-testid="${shellFooterTestID(key)}"]:visible`).first();
}

function footerSettingsRows(page: Page): Locator {
  return page
    .getByTestId("sidebar-nav-section-footer")
    .locator('[data-testid^="sidebar-nav-item-"]');
}

export async function expectFooterSettingsKeys(page: Page, keys: string[]): Promise<void> {
  await expect
    .poll(async () =>
      (
        await footerSettingsRows(page).evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-testid")),
        )
      ).map((testID) => testID?.replace("sidebar-nav-item-", "")),
    )
    .toEqual(keys);
}

export async function moveFooterItemUp(page: Page, key: string): Promise<void> {
  await page
    .getByTestId("sidebar-nav-section-footer")
    .getByTestId(`sidebar-nav-move-up-${key}`)
    .click();
}

function footerItemSwitch(page: Page, key: string): Locator {
  return page.getByTestId("sidebar-nav-section-footer").getByTestId(`sidebar-nav-toggle-${key}`);
}

export async function setFooterItemVisible(
  page: Page,
  key: string,
  visible: boolean,
): Promise<void> {
  const toggle = footerItemSwitch(page, key);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(visible));
}

/** Whether Settings > Sidebar shows a footer item as on. */
export async function expectFooterItemSetting(
  page: Page,
  key: string,
  visible: boolean,
): Promise<void> {
  await expect(footerItemSwitch(page, key)).toHaveAttribute("aria-checked", String(visible));
}

export async function expectFooterOrder(page: Page, keys: string[]): Promise<void> {
  await expectVerticalOrder(keys, (key) => shellFooterRow(page, key), "sidebar footer rows");
}

export async function expectFooterItemHidden(page: Page, key: string): Promise<void> {
  await expect(page.locator(`[data-testid="${shellFooterTestID(key)}"]:visible`)).toHaveCount(0);
}

const FOOTER_ICON_TEST_IDS = [
  "sidebar-add-project",
  "sidebar-usage-icon",
  "sidebar-hosts-trigger",
  "sidebar-help",
  "sidebar-settings",
];

// Browser layout boxes include floating-point rounding, even for whole-pixel styles.
const FOOTER_GEOMETRY_TOLERANCE = 0.01;

/**
 * One line of same-size icons: Add project, Usage and Hosts together on the left, Help and
 * Settings together at the end.
 */
export async function expectFooterIconRow(page: Page): Promise<void> {
  const boxes = (
    await Promise.all(
      FOOTER_ICON_TEST_IDS.map((testID) =>
        page.locator(`[data-testid="${testID}"]:visible`).first().boundingBox(),
      ),
    )
  ).map((box) => box!);
  const [first] = boxes;
  for (const box of boxes) {
    expect(Math.abs(box.y + box.height / 2 - first!.y - first!.height / 2)).toBeLessThan(2);
    expect(Math.abs(box.width - first!.width)).toBeLessThan(FOOTER_GEOMETRY_TOLERANCE);
  }
  const gaps = boxes.slice(1).map((box, index) => box.x - (boxes[index]!.x + boxes[index]!.width));
  for (const index of [0, 1, 3]) {
    expect(Math.abs(gaps[index]!)).toBeLessThan(FOOTER_GEOMETRY_TOLERANCE);
  }
  expect(gaps[2]).toBeGreaterThan(first!.width);
}

export async function expectFooterSeparator(page: Page, shown: boolean): Promise<void> {
  await expect(page.locator('[data-testid="sidebar-footer"]:visible')).toHaveCSS(
    "border-top-width",
    "1px",
  );
  await expect(page.locator('[data-testid="sidebar-footer-bottom-line"]:visible')).toHaveCSS(
    "border-top-width",
    "0px",
  );
  const separator = page.locator('[data-testid="sidebar-footer-separator"]:visible');
  await expect(separator).toHaveCount(shown ? 1 : 0);
  expect(
    await separator.evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).borderBottomWidth),
    ),
  ).toEqual(shown ? ["1px"] : []);
}

export async function hoverFooterAddProject(page: Page): Promise<void> {
  await page.locator('[data-testid="sidebar-add-project"]:visible').hover();
  const tooltip = page.getByTestId("sidebar-add-project-tooltip");
  await expect(tooltip.getByText("Add project", { exact: true })).toBeVisible();
  await expect(tooltip.getByText("Ctrl+O", { exact: true })).toBeVisible();
}

export async function footerScreenshot(page: Page, name: string): Promise<void> {
  const directory = process.env.PASEO_QA_SCREENSHOT_DIR;
  if (!directory) return;
  await page.waitForTimeout(600);
  await page.addStyleTag({ content: ".__expo_fast_refresh { display: none !important; }" });
  await page.screenshot({ path: path.join(directory, `${name}.png`) });
}
