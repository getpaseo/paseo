import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import {
  openNewWorkspaceComposer,
  openStartingRefPicker,
  selectBranchInPicker,
  selectWorkspaceIsolation,
  watchBrowserBranchSuggestions,
} from "../support/helpers/new-workspace";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { seedSavedSettingsHosts } from "../support/helpers/settings";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

const LONG_HOST_NAME =
  "development-macbook-pro.local-connected-through-a-very-long-private-hostname";
const LONG_BRANCH_NAME =
  "feat/app/add-amoled-theme-with-a-very-long-pull-request-and-branch-description";
const MANY_BRANCHES = Array.from(
  { length: 12 },
  (_, index) => `feat/branch-${String(index + 1).padStart(2, "0")}`,
);

interface PopoverFrameSample {
  t: number;
  opacity: number;
  top: number;
  left: number;
  width: number;
  height: number;
  rowCount: number;
  mainTop: number | null;
}

function measureControlRightEdges(controls: HTMLElement[]) {
  const measurements: Array<{ label: string | null; right: number }> = [];
  for (const control of controls) {
    const rect = control.getBoundingClientRect();
    measurements.push({ label: control.getAttribute("aria-label"), right: rect.right });
  }
  return measurements;
}

async function startPopoverFrameSampler(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as unknown as {
      __popoverFrames?: PopoverFrameSample[];
      __popoverSamplerStop?: () => void;
    };
    const samples: PopoverFrameSample[] = [];
    const start = performance.now();
    let stopped = false;
    let rafId = 0;
    const tick = () => {
      if (stopped) return;
      const el = document.querySelector<HTMLElement>('[data-testid="combobox-desktop-container"]');
      if (el) {
        const style = getComputedStyle(el);
        const opacity = Number.parseFloat(style.opacity || "1");
        const rect = el.getBoundingClientRect();
        const rows = el.querySelectorAll("[data-combobox-option-index]");
        const mainEl = el.querySelector<HTMLElement>(
          '[data-testid="new-workspace-ref-picker-branch-main"]',
        );
        samples.push({
          t: Math.round(performance.now() - start),
          opacity,
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          rowCount: rows.length,
          mainTop: mainEl ? Math.round(mainEl.getBoundingClientRect().top) : null,
        });
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    win.__popoverFrames = samples;
    win.__popoverSamplerStop = () => {
      stopped = true;
      cancelAnimationFrame(rafId);
    };
  });
}

async function stopPopoverFrameSampler(
  page: import("@playwright/test").Page,
): Promise<PopoverFrameSample[]> {
  return page.evaluate(() => {
    const win = window as unknown as {
      __popoverFrames?: PopoverFrameSample[];
      __popoverSamplerStop?: () => void;
    };
    win.__popoverSamplerStop?.();
    return win.__popoverFrames ?? [];
  });
}

test.describe("New workspace metadata row layout", () => {
  let workspace: SeededWorkspace;

  test.beforeEach(async () => {
    workspace = await seedWorkspace({
      repoPrefix: "new-workspace-layout-",
      repo: { branches: [LONG_BRANCH_NAME, ...MANY_BRANCHES] },
    });
  });

  test.afterEach(async () => {
    await workspace?.cleanup();
  });

  test("long host and branch names stay inside the composer's right rail", async ({ page }) => {
    await page.setViewportSize({ width: 2048, height: 878 });
    await seedSavedSettingsHosts(page, [
      {
        serverId: getServerId(),
        label: LONG_HOST_NAME,
        endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
      },
      {
        serverId: "srv_e2e_layout_offline",
        label: "Offline host",
        endpoint: "127.0.0.1:9",
      },
    ]);

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, {
      projectKey: workspace.projectKey,
      projectDisplayName: workspace.projectDisplayName,
    });
    await selectWorkspaceIsolation(page, "worktree");
    await openStartingRefPicker(page);
    await selectBranchInPicker(page, LONG_BRANCH_NAME);

    const composer = page.locator('[data-testid="message-input-root"]:visible');
    const metadataRow = page.getByTestId("new-workspace-ref-picker-row");
    await expect(composer).toBeVisible();
    await expect(metadataRow).toBeVisible();

    const [composerBox, controlBoxes] = await Promise.all([
      composer.boundingBox(),
      metadataRow.getByRole("button").evaluateAll(measureControlRightEdges),
    ]);
    expect(composerBox).not.toBeNull();
    const composerRightRail = composerBox!.x + composerBox!.width;

    for (const control of controlBoxes) {
      expect(
        control.right,
        `${control.label ?? "Metadata control"} crossed the composer rail`,
      ).toBeLessThanOrEqual(composerRightRail + 1);
    }
  });

  test("starting ref popover holds height and row positions on a cold first open", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const branchWatch = await watchBrowserBranchSuggestions(page, { hold: true });

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, {
      projectKey: workspace.projectKey,
      projectDisplayName: workspace.projectDisplayName,
    });
    await selectWorkspaceIsolation(page, "worktree");

    await startPopoverFrameSampler(page);
    await openStartingRefPicker(page);

    const popover = page.getByTestId("combobox-desktop-container");
    await expect(popover).toBeVisible({ timeout: 10_000 });
    await branchWatch.waitForResponse();

    // Give the loading state several frames to paint before releasing the branch list.
    await page.waitForTimeout(120);
    const loadingBox = await popover.boundingBox();
    expect(loadingBox).not.toBeNull();

    branchWatch.release();
    await expect(page.getByTestId("new-workspace-ref-picker-branch-feat/branch-12")).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForTimeout(80);
    const settledBox = await popover.boundingBox();
    expect(settledBox).not.toBeNull();

    const samples = await stopPopoverFrameSampler(page);
    const visibleSamples = samples.filter((s) => s.opacity > 0.9);
    expect(visibleSamples.length).toBeGreaterThan(0);

    const heights = visibleSamples.map((s) => s.height);
    const tops = visibleSamples.map((s) => s.top);
    const mainTops = visibleSamples
      .map((s) => s.mainTop)
      .filter((value): value is number => value !== null);

    expect(
      Math.max(...heights) - Math.min(...heights),
      `popover height shifted across visible frames: ${JSON.stringify(visibleSamples)}`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.max(...tops) - Math.min(...tops),
      `popover top shifted across visible frames: ${JSON.stringify(visibleSamples)}`,
    ).toBeLessThanOrEqual(1);
    expect(
      mainTops.length > 0 ? Math.max(...mainTops) - Math.min(...mainTops) : 0,
      `main row jumped vertically across visible frames: ${JSON.stringify(visibleSamples)}`,
    ).toBeLessThanOrEqual(1);

    // Switching to Pull requests keeps the same frame height.
    await page.getByTestId("new-workspace-ref-picker-tab-pull-requests").click();
    await page.waitForTimeout(80);
    const prBox = await popover.boundingBox();
    expect(prBox).not.toBeNull();
    expect(Math.abs(prBox!.height - settledBox!.height)).toBeLessThanOrEqual(1);
  });

  test("starting ref popover prefetches branches before the first click and clamps to short viewports", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const branchWatch = await watchBrowserBranchSuggestions(page, { hold: false });

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, {
      projectKey: workspace.projectKey,
      projectDisplayName: workspace.projectDisplayName,
    });
    await selectWorkspaceIsolation(page, "worktree");

    // Branches must prefetch before the user ever clicks the trigger.
    await branchWatch.waitForResponse();
    await page.waitForTimeout(100);

    await startPopoverFrameSampler(page);
    await openStartingRefPicker(page);
    await expect(page.getByTestId("new-workspace-ref-picker-branch-feat/branch-12")).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForTimeout(80);
    const samples = await stopPopoverFrameSampler(page);
    const firstVisible = samples.find((s) => s.opacity > 0.9);
    expect(firstVisible).toBeDefined();
    expect(firstVisible!.rowCount).toBeGreaterThan(5);

    // Close and verify short viewport clamping keeps the popover inside the window.
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1280, height: 500 });
    await openStartingRefPicker(page);
    const popover = page.getByTestId("combobox-desktop-container");
    await expect(popover).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(100);
    const shortBox = await popover.boundingBox();
    expect(shortBox).not.toBeNull();
    expect(shortBox!.y + shortBox!.height).toBeLessThanOrEqual(500);
  });
});
