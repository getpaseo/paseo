import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";

interface DragMeasurement {
  observer: MutationObserver;
  stylesheetMutations: number;
}

declare global {
  interface Window {
    __PASEO_EXPLORER_DRAG_MEASUREMENT__?: DragMeasurement;
  }
}

async function waitForResizePaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function beginResizeMeasurement(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stylesheet = document.getElementById("unistyles-web");
    if (!stylesheet) throw new Error("Shared stylesheet is missing");
    globalThis.__PASEO_RESET_RENDER_PROFILE__!();
    const measurement: DragMeasurement = {
      stylesheetMutations: 0,
      observer: new MutationObserver((records) => {
        measurement.stylesheetMutations += records.length;
      }),
    };
    measurement.observer.observe(stylesheet, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    window.__PASEO_EXPLORER_DRAG_MEASUREMENT__ = measurement;
  });
}

async function previewExplorerResize(page: Page, distance: number) {
  const handle = page
    .getByTestId("workspace-explorer-sidebar-resize-handle")
    .getByRole("separator");
  const explorer = page.getByTestId("workspace-explorer-sidebar");
  const bounds = await handle.boundingBox();
  if (!bounds) throw new Error("Explorer resize handle is missing");
  const before = (await explorer.boundingBox())!.width;
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + 100;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await waitForResizePaint(page);
  await beginResizeMeasurement(page);
  for (let move = 1; move <= 20; move++) {
    await page.mouse.move(x + (distance * move) / 20, y);
    await waitForResizePaint(page);
  }
  const during = (await explorer.boundingBox())!.width;
  const measurement = await page.evaluate(() => {
    const state = window.__PASEO_EXPLORER_DRAG_MEASUREMENT__!;
    state.observer.disconnect();
    return {
      stylesheetMutations: state.stylesheetMutations,
      paneRenders: Object.entries(globalThis.__PASEO_RENDER_PROFILE_REASONS__ ?? {})
        .filter(([id]) => id.startsWith("SplitPaneView:"))
        .reduce((sum, [, reasons]) => sum + (reasons.render ?? 0), 0),
    };
  });
  await page.mouse.up();
  await waitForResizePaint(page);
  const after = (await explorer.boundingBox())!.width;
  expect(during).toBeCloseTo(before - distance, 0);
  expect(after).toBeCloseTo(during, 0);
  return { ...measurement, width: after };
}

async function expectExplorerWidthSurvivesReload(page: Page, width: number): Promise<void> {
  await page.reload();
  const explorer = page.getByTestId("workspace-explorer-sidebar");
  await expect(explorer).toBeVisible();
  await expect.poll(async () => (await explorer.boundingBox())?.width).toBeCloseTo(width, 0);
}

test("Explorer drag previews without rerendering panes or rewriting the shared stylesheet", async ({
  page,
  withWorkspace,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    globalThis.__PASEO_RENDER_PROFILE_ENABLED__ = true;
  });
  const workspace = await withWorkspace();
  await workspace.navigateTo();
  await runWorkspaceActionFromCommandCenter(page, "Split pane right");
  await runWorkspaceActionFromCommandCenter(page, "Split pane right");
  await page.getByTestId("workspace-explorer-toggle").first().click();
  await expect(page.getByTestId("workspace-explorer-sidebar")).toBeVisible();
  // Verify that direct pane renders are being counted before resetting them.
  expect(
    await page.evaluate(() =>
      Object.keys(globalThis.__PASEO_RENDER_PROFILE_REASONS__ ?? {}).some((id) =>
        id.startsWith("SplitPaneView:"),
      ),
    ),
  ).toBe(true);
  const grown = await previewExplorerResize(page, -100);
  const shrunk = await previewExplorerResize(page, 50);
  expect(grown.stylesheetMutations).toBe(0);
  expect(grown.paneRenders).toBe(0);
  expect(shrunk.stylesheetMutations).toBe(0);
  expect(shrunk.paneRenders).toBe(0);
  await expectExplorerWidthSurvivesReload(page, shrunk.width);
});
