import { expect, type Locator, type Page } from "@playwright/test";

/** Every footer control that can sit in the icon line, caret included. */
const FOOTER_LINE_TEST_IDS = [
  "sidebar-add-project",
  "sidebar-usage-icon",
  "sidebar-hosts-trigger",
  "sidebar-help",
  "sidebar-footer-overflow",
  "sidebar-settings",
];

// Browser layout boxes include floating-point rounding, even for whole-pixel styles.
const GEOMETRY_TOLERANCE = 0.01;

/** Open the app with the docked sidebar at `width`, as if the user had dragged it there. */
export async function seedDockedSidebarWidth(page: Page, width: number): Promise<void> {
  await page.addInitScript((sidebarWidth) => {
    localStorage.setItem("panel-state", JSON.stringify({ version: 17, state: { sidebarWidth } }));
  }, width);
}

function footerLine(page: Page): Locator {
  return page.locator('[data-testid="sidebar-footer-bottom-line"]:visible');
}

export function footerOverflowMenu(page: Page): Locator {
  return page.getByTestId("sidebar-footer-overflow-menu");
}

/**
 * The icon line shows exactly `testIDs`, in order, each `controlSize` square and wholly inside the
 * line's box, so no button is cut off by the sidebar's edge.
 */
export async function expectFooterLine(
  page: Page,
  input: { testIDs: string[]; controlSize: number },
): Promise<void> {
  const line = footerLine(page);
  await expect(line).toHaveCount(1);
  await expect
    .poll(async () =>
      line
        .locator(FOOTER_LINE_TEST_IDS.map((testID) => `[data-testid="${testID}"]`).join(","))
        .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-testid"))),
    )
    .toEqual(input.testIDs);
  const { row, buttons } = await line.evaluate((element, testIDs) => {
    const rect = (node: Element) => {
      const { x, width, height } = node.getBoundingClientRect();
      return { x, width, height };
    };
    return {
      row: rect(element),
      buttons: testIDs.map((testID) => rect(element.querySelector(`[data-testid="${testID}"]`)!)),
    };
  }, input.testIDs);
  for (const button of buttons) {
    expect(Math.abs(button.width - input.controlSize)).toBeLessThan(GEOMETRY_TOLERANCE);
    expect(Math.abs(button.height - input.controlSize)).toBeLessThan(GEOMETRY_TOLERANCE);
    expect(button.x).toBeGreaterThanOrEqual(row.x - GEOMETRY_TOLERANCE);
    expect(button.x + button.width).toBeLessThanOrEqual(row.x + row.width + GEOMETRY_TOLERANCE);
  }
}

export async function openFooterOverflow(page: Page): Promise<void> {
  await footerLine(page).getByTestId("sidebar-footer-overflow").click();
  await expect(footerOverflowMenu(page)).toBeVisible();
}

/** The overflow menu lists exactly these actions, in row order. */
export async function expectFooterOverflowActions(page: Page, names: string[]): Promise<void> {
  await expect(footerOverflowMenu(page).getByRole("menuitem")).toHaveText(names);
}

export async function chooseFooterOverflowAction(page: Page, name: string): Promise<void> {
  await footerOverflowMenu(page).getByRole("menuitem", { name }).click();
}
