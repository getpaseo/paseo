import { test } from "../support/fixtures";
import {
  expectToolbarNeverCondensedOrClipped,
  recordToolbarFramesFromLoad,
  withComposerControlsExample,
  withPickerComposerItem,
  withToggleAndWatcherComposerItems,
} from "../support/helpers/plugin-composer-items";

test("a narrow composer's overflow sheet shows a plugin item's row", async ({ page }) => {
  test.setTimeout(120_000);
  await withComposerControlsExample(page, async (composer) => {
    await composer.narrowTheWindow();
    await composer.openAgentFeatures();
    await composer.expectFeatureRow("Needs review");
    await composer.expectFeatureRow("Insert checklist");
  });
});

test("a toolbar with room keeps a plugin toggle inline at full density", async ({ page }) => {
  test.setTimeout(120_000);
  await withToggleAndWatcherComposerItems(page, async (composer) => {
    // Wider than what renders, too narrow for two 125-wide "Plugin item" estimates.
    await composer.setWindowWidth(1000);
    await composer.expectToolbarWidthBetween(470, 620);
    await composer.expectToggleInlineAtFullDensity();
  });
});

test("a toolbar without room moves a plugin toggle to the overflow sheet and back", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await withToggleAndWatcherComposerItems(page, async (composer) => {
    await composer.setWindowWidth(1000);
    await composer.expectToggleInlineAtFullDensity();
    // Too narrow for full labels, wide enough that the controls have not folded away.
    await composer.setWindowWidth(880);
    await composer.expectToolbarWidthBetween(300, 395);
    await composer.expectToggleInOverflow();
    await composer.closeOverflowSheet();
    await composer.setWindowWidth(1000);
    await composer.expectToggleInlineAtFullDensity();
  });
});

test("an open plugin picker closes when its trigger moves to the overflow", async ({ page }) => {
  test.setTimeout(120_000);
  await withPickerComposerItem(page, async (composer) => {
    await composer.setWindowWidth(1000);
    await composer.openInlinePicker();
    await composer.setWindowWidth(880);
    await composer.expectToolbarWidthBetween(300, 395);
    await composer.expectPickerClosed();
  });
});

test("the toolbar settles on one density without flipping as the window widens", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await withToggleAndWatcherComposerItems(page, async (composer) => {
    await composer.setWindowWidth(880);
    await composer.expectToolbarWidthBetween(300, 395);
    await composer.startRecordingDensity();
    for (let width = 880; width <= 1000; width += 8) await composer.setWindowWidth(width);
    await composer.expectAtMostOneDensityChange();
  });
});

test("a toolbar with room never paints condensed or clipped while the plugin loads", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1000, height: 800 });
  await recordToolbarFramesFromLoad(page);
  await withToggleAndWatcherComposerItems(page, async (composer) => {
    await composer.expectToggleInlineAtFullDensity();
    await expectToolbarNeverCondensedOrClipped(page);
  });
});
