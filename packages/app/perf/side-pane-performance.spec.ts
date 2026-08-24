import { test, expect } from "@playwright/test";
import {
  changedFileRows,
  closeWorkingDiffPane,
  enableChangesOpenInSidePane,
  expectProfilerDidNotMount,
  expectTrackedNodePreserved,
  expectWorkingDiffVisible,
  measureInteraction,
  measureHeapAfterGc,
  openChangesExplorer,
  openProfileWorkspace,
  resolveProfileTarget,
  selectChangedFile,
  type InteractionMeasurement,
} from "./helpers/side-pane-performance";

const MAIN_PANE = '[data-testid="workspace-pane-main"]';
const WORKING_DIFF = '[data-testid="working-diff-panel"]';
const DIFF_CANVAS = '[data-testid="git-diff-canvas-root"]';
const DIFF_TAB = '[data-testid="workspace-tab-working_diff"]';

test("side-pane diff transitions preserve mounted work and report their real React cost", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const target = resolveProfileTarget();
  const reports: InteractionMeasurement[] = [];

  await test.step("open the real main workspace with Changes routed beside it", async () => {
    await openProfileWorkspace(page, target);
    await enableChangesOpenInSidePane(page);
    await openChangesExplorer(page);
    expect(await changedFileRows(page).count()).toBeGreaterThanOrEqual(2);
  });

  await test.step("creating the side pane keeps the main pane mounted", async () => {
    const report = await measureInteraction(page, {
      name: "create-side-pane",
      trackedSelectors: [MAIN_PANE],
      interact: () => selectChangedFile(page, 0),
      expectComplete: () => expectWorkingDiffVisible(page),
    });
    reports.push(report);
    await testInfo.attach(report.name, {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });
    expectTrackedNodePreserved(report, MAIN_PANE);
  });

  await test.step("changing the selected diff file updates the existing diff in place", async () => {
    const report = await measureInteraction(page, {
      name: "change-diff-focus",
      trackedSelectors: [MAIN_PANE, WORKING_DIFF, DIFF_CANVAS, DIFF_TAB],
      interact: () => selectChangedFile(page, 1),
      expectComplete: () => expectWorkingDiffVisible(page),
    });
    reports.push(report);
    await testInfo.attach(report.name, {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });
    expectTrackedNodePreserved(report, MAIN_PANE);
    expectTrackedNodePreserved(report, WORKING_DIFF);
    expectTrackedNodePreserved(report, DIFF_CANVAS);
    expectTrackedNodePreserved(report, DIFF_TAB);
    expectProfilerDidNotMount(report, "WorkingDiffPanel:");
  });

  await test.step("repeated cold reopenings measure retained workspace work", async () => {
    for (let index = 0; index < 5; index += 1) {
      await closeWorkingDiffPane(page);
      const report = await measureInteraction(page, {
        name: `reopen-side-pane-${index + 1}`,
        trackedSelectors: [MAIN_PANE],
        interact: () => selectChangedFile(page, index % 2),
        expectComplete: () => expectWorkingDiffVisible(page),
      });
      report.heapAfterGcBytes = await measureHeapAfterGc(page);
      reports.push(report);
      await testInfo.attach(report.name, {
        body: JSON.stringify(report, null, 2),
        contentType: "application/json",
      });
      expectTrackedNodePreserved(report, MAIN_PANE);
      expect(
        report.renders.some(
          (summary) => summary.id.startsWith("WorkingDiffPanel:") && summary.mounts > 0,
        ),
      ).toBe(true);
    }
  });

  const artifact = {
    appUrl: testInfo.project.use.baseURL,
    target,
    reports,
  };
  await testInfo.attach("side-pane-performance", {
    body: JSON.stringify(artifact, null, 2),
    contentType: "application/json",
  });
  console.log(
    `[perf] Side pane: ${JSON.stringify(
      reports.map((report) => ({
        name: report.name,
        latencyMs: report.latencyMs,
        commits: report.commits,
        domMutations: report.domMutations,
        addedElements: report.addedElements,
        removedElements: report.removedElements,
        heapAfterGcBytes: report.heapAfterGcBytes,
        trackedNodes: report.trackedNodes,
        renders: report.renders.slice(0, 8),
      })),
    )}`,
  );
});
