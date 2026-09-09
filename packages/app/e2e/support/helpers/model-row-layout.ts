import type { Locator } from "@playwright/test";
import type { Page } from "@playwright/test";
import { expect, test } from "./model-visibility-fixture";
import { clickNewChat, gotoWorkspace } from "./launcher";

/**
 * Geometry regression for the provider settings model rows. Long labels and
 * IDs must truncate inside the row while the visibility switch (and the
 * custom-row delete button) stay at a fixed right edge, and nothing in the
 * sheet may scroll horizontally.
 */

export const PROVIDER = {
  id: "mock-row-layout",
  label: "Mock Row Layout",
  models: [
    {
      id: "layout-default",
      isDefault: true,
      label: "Layout default with a deliberately long human readable label",
      description: "A long description so the description column also has to give way.",
    },
    {
      id: "layout-no-description",
      label: "Layout row without a description to exercise the filler",
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `layout-model-${index}-long-provider-qualified-experimental-2026-09-07`,
      label: `Layout ${index} extended reasoning assistant with detailed capability label`,
      description: `Model ${index}: long catalog description covering coding, planning and multimodal analysis.`,
    })),
  ],
  additionalModels: [
    {
      id: "custom-layout-model-with-a-very-long-identifier-2026-09-07-preview",
      label: "Custom layout model with an equally long label",
    },
  ],
};

function sheet(page: Page) {
  return page.getByTestId("provider-settings-sheet");
}

/**
 * A model listed in `additionalModels` is merged into the runtime catalog by
 * exact ID, so it renders once under Discovered and once under Custom, sharing
 * one visibility setting. Both rows carry the same testID, so per-model
 * lookups take the first match and whole-sheet checks iterate every row.
 */
function controls(page: Page, modelId: string) {
  return page.getByTestId(`provider-model-controls-${modelId}`).first();
}

function visibilitySwitch(page: Page, modelId: string) {
  return page.getByTestId(`provider-model-visibility-${modelId}`).first();
}

/**
 * Page-scoped, not sheet-scoped: on compact the sheet body renders through a
 * portal outside the node carrying the settings-sheet testID, so scoping to
 * that node finds nothing even though the rows are on screen.
 */
function allVisibilitySwitches(page: Page) {
  return page.locator('[data-testid^="provider-model-visibility-"]');
}

/**
 * The box the rows are actually laid out in. Controls must sit inside it, which
 * is the real H1 requirement: a switch outside it cannot be clicked or tapped.
 */
async function rowContainerBox(page: Page) {
  const rect = await controls(page, PROVIDER.models[0].id).evaluate((node) => {
    let element: HTMLElement | null = node as HTMLElement;
    while (element) {
      const style = getComputedStyle(element);
      if (style.overflowX !== "visible" || style.overflowY !== "visible") {
        const bounds = element.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      }
      element = element.parentElement;
    }
    return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  });
  return rect;
}

async function box(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const rect = await locator.boundingBox();
  if (!rect) throw new Error(`No bounding box for ${String(locator)}`);
  return rect;
}

async function openPicker(page: Page, compact: boolean) {
  await page.getByTestId("combined-model-selector").filter({ visible: true }).first().click();
  if (compact) {
    await expect(page.getByTestId("agent-controls-model-sheet")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("agent-controls-model").click();
    await expect(page.getByTestId("agent-controls-model-browser-sheet")).toBeVisible({
      timeout: 30_000,
    });
    return;
  }
  await expect(page.getByTestId("combobox-desktop-container")).toBeVisible({ timeout: 30_000 });
}

async function openProviderSettings(page: Page, compact: boolean) {
  const view = page.getByTestId(
    compact ? "agent-controls-model-browser-sheet" : "combobox-desktop-container",
  );
  if (!compact) {
    const back = view.getByRole("button", { name: "Back", exact: true });
    await expect(back).toBeVisible();
    await back.click();
  }
  const providerRow = page.getByTestId(`model-provider-${PROVIDER.id}`).filter({ visible: true });
  await expect(providerRow).toBeVisible({ timeout: 30_000 });
  await providerRow.click();
  await page
    .getByRole("button", { name: `Open ${PROVIDER.label} settings`, exact: true })
    .filter({ visible: true })
    .click();
  await expect(sheet(page)).toBeVisible({ timeout: 30_000 });
}

async function newChat(page: Page, compact: boolean) {
  if (compact) {
    await page.getByRole("button", { name: "Workspace actions", exact: true }).click();
    await page.getByTestId("workspace-header-new-agent").click();
    return;
  }
  await clickNewChat(page);
}

/** Every scroll container inside the sheet must fit its content horizontally. */
async function expectNoHorizontalOverflow(page: Page) {
  // Walks up from a real row rather than scoping to the sheet testID, which on
  // compact holds only the title and would pass vacuously. Any horizontally
  // scrollable ancestor is the H2 defect: focus or scroll-into-view can then
  // slide the label column off screen.
  const offenders = await controls(page, PROVIDER.models[0].id).evaluate((node) => {
    const found: string[] = [];
    const seen = new Set<HTMLElement>();
    const check = (el: HTMLElement) => {
      if (seen.has(el)) return;
      seen.add(el);
      const overflowX = getComputedStyle(el).overflowX;
      if (overflowX !== "auto" && overflowX !== "scroll") return;
      if (el.scrollWidth > el.clientWidth + 1) {
        found.push(
          `${el.tagName.toLowerCase()}[data-testid=${el.dataset.testid ?? ""}] scrollWidth=${el.scrollWidth} clientWidth=${el.clientWidth}`,
        );
      }
    };
    let ancestor: HTMLElement | null = node as HTMLElement;
    let container: HTMLElement | null = null;
    while (ancestor) {
      check(ancestor);
      if (!container) {
        const style = getComputedStyle(ancestor);
        if (style.overflowX !== "visible" || style.overflowY !== "visible") container = ancestor;
      }
      ancestor = ancestor.parentElement;
    }
    for (const element of (container ?? document.body).querySelectorAll("*")) {
      check(element as HTMLElement);
    }
    return found;
  });
  expect(offenders, "horizontally scrollable containers around the model rows").toEqual([]);
}

export async function checkModelRowLayout(
  page: Page,
  workspace: { workspaceId: string },
  compact: boolean,
) {
  const allModels = [...PROVIDER.models, ...PROVIDER.additionalModels];
  await gotoWorkspace(page, workspace.workspaceId);
  await newChat(page, compact);
  await openPicker(page, compact);
  await openProviderSettings(page, compact);
  // Every discovered row plus the custom section's own row for the model
  // that appears in both.
  const expectedSwitchCount = PROVIDER.models.length + PROVIDER.additionalModels.length * 2;
  await expect(allVisibilitySwitches(page)).toHaveCount(expectedSwitchCount, {
    timeout: 30_000,
  });

  const containerBox = await rowContainerBox(page);
  const containerRight = containerBox.x + containerBox.width;

  await test.step("every switch is inside the sheet and shares one right edge", async () => {
    // Iterates rendered rows rather than model IDs, so the model that
    // appears in both sections is checked in both.
    const switches = allVisibilitySwitches(page);
    const count = await switches.count();
    expect(count).toBe(expectedSwitchCount);
    const rightEdges: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const toggle = switches.nth(index);
      const label = (await toggle.getAttribute("data-testid")) ?? `row ${index}`;
      await expect(toggle).toBeVisible();
      const rect = await box(toggle);
      expect(rect.x, `${label} switch left edge`).toBeGreaterThanOrEqual(containerBox.x);
      expect(rect.x + rect.width, `${label} switch right edge`).toBeLessThanOrEqual(containerRight);
      rightEdges.push(rect.x + rect.width);
    }
    const reference = rightEdges[0];
    for (const [index, edge] of rightEdges.entries()) {
      expect(Math.abs(edge - reference), `row ${index} switch alignment`).toBeLessThan(1.5);
    }
  });

  await test.step("labels stay visible and end before the control column", async () => {
    for (const model of allModels) {
      const control = controls(page, model.id);
      const controlBox = await box(control);
      // Scoped to the row that owns these controls. A page-wide text match
      // can land on the same label in the model browser behind this sheet.
      const label = control.locator("..").getByText(model.label, { exact: true }).first();
      await expect(label).toBeVisible();
      const labelBox = await box(label);
      expect(labelBox.width, `${model.id} label width`).toBeGreaterThan(0);
      expect(
        labelBox.x + labelBox.width,
        `${model.id} label overlaps controls`,
      ).toBeLessThanOrEqual(controlBox.x + 0.5);
    }
  });

  await test.step("the custom row's delete button sits left of its switch", async () => {
    const custom = PROVIDER.additionalModels[0];
    // Page-scoped for the same reason as the other row locators: the compact
    // sheet body is portaled outside the settings-sheet testID node.
    const remove = page.getByTestId(`provider-model-remove-${custom.id}`).first();
    await expect(remove).toBeVisible();
    const removeBox = await box(remove);
    const toggleBox = await box(visibilitySwitch(page, custom.id));
    expect(removeBox.x + removeBox.width).toBeLessThanOrEqual(toggleBox.x);
    expect(removeBox.x).toBeGreaterThanOrEqual(containerBox.x);
  });

  await test.step("nothing in the sheet scrolls horizontally", async () => {
    await expectNoHorizontalOverflow(page);
  });
}
