import { writeFile } from "node:fs/promises";
import type { CDPSession, Page } from "@playwright/test";
import { buildAgentRoute } from "./support/helpers/mock-agent";
import { seedWorkspace, type SeededWorkspace } from "./support/helpers/seed-client";
import { test } from "./support/fixtures";
import type {
  BenchmarkCaseResult,
  BenchmarkMetricResult,
  BenchmarkTaskResult,
} from "../scripts/benchmark-support";
import {
  BENCHMARK_FRAME_INTERVAL_MS,
  summarizeFrameGaps,
  summarizeSamples,
} from "../scripts/benchmark-support";

const TAB_COUNTS = [1, 8, 20] as const;
const HOVER_CYCLES = 100;
const VIEWPORT = { width: 1440, height: 900 };

interface HoverMeasurementState {
  feedbackMs: number[];
  frameGapsMs: number[];
  longTaskDurationsMs: number[];
  stop: () => void;
}

interface BenchmarkWindow extends Window {
  __PASEO_RENDER_PROFILE__?: Array<{
    id: string;
    actualDuration: number;
    commitTime: number;
  }>;
  __PASEO_RESET_RENDER_PROFILE__?: () => void;
  __PASEO_CSS_HOVER_MEASUREMENT__?: HoverMeasurementState;
}

function durationMetric(samples: number[]): BenchmarkMetricResult {
  const summary = summarizeSamples(samples);
  return {
    unit: "ms",
    values: { p50: summary.p50, p95: summary.p95 },
    samples: summary.samples,
  };
}

function scalarMetric(unit: string, value: number): BenchmarkMetricResult {
  return { unit, values: { total: value } };
}

function appendRenderProfile(route: string): string {
  return `${route}${route.includes("?") ? "&" : "?"}renderProfile=1`;
}

async function createAgents(workspace: SeededWorkspace, count: number) {
  return Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const created = await workspace.client.createAgent({
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: `CSS hover tab ${count}-${index}`,
        modeId: "load-test",
        model: "ten-second-stream",
      });
      return created.id;
    }),
  );
}

async function openAgentTabs(page: Page, workspaceId: string, agentIds: string[]): Promise<void> {
  for (const agentId of agentIds) {
    await page.goto(appendRenderProfile(buildAgentRoute(workspaceId, agentId)));
    await page.waitForURL(
      (url) =>
        url.pathname.includes("/workspace/") &&
        !url.searchParams.has("open") &&
        url.searchParams.get("renderProfile") === "1",
      { timeout: 60_000 },
    );
    await page.getByTestId(`workspace-tab-agent_${agentId}`).waitFor({ timeout: 60_000 });
  }
  for (const agentId of agentIds) {
    await page.getByTestId(`workspace-tab-agent_${agentId}`).waitFor({ state: "attached" });
  }
}

async function armHoverMeasurement(page: Page, targetTestId: string): Promise<void> {
  await page.evaluate(
    ({ testId }) => {
      const benchmarkWindow = window as BenchmarkWindow;
      benchmarkWindow.__PASEO_RESET_RENDER_PROFILE__?.();
      const feedbackMs: number[] = [];
      const frameGapsMs: number[] = [];
      const longTaskDurationsMs: number[] = [];
      const longTaskObserver =
        typeof PerformanceObserver === "undefined"
          ? null
          : new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) longTaskDurationsMs.push(entry.duration);
            });
      try {
        longTaskObserver?.observe({ type: "longtask" });
      } catch {
        longTaskObserver?.disconnect();
      }

      let frameHandle = 0;
      let previousFrameAt = performance.now();
      const sampleFrame = (now: number) => {
        frameGapsMs.push(now - previousFrameAt);
        previousFrameAt = now;
        frameHandle = requestAnimationFrame(sampleFrame);
      };
      frameHandle = requestAnimationFrame(sampleFrame);

      const handlePointerOver = (event: PointerEvent) => {
        const eventTarget = event.target instanceof Element ? event.target : null;
        const target = eventTarget?.closest<HTMLElement>(`[data-testid="${testId}"]`) ?? null;
        if (!target) return;
        const relatedTarget = event.relatedTarget instanceof Element ? event.relatedTarget : null;
        if (relatedTarget?.closest(`[data-testid="${testId}"]`) === target) return;
        const startedAt = performance.now();
        requestAnimationFrame(() => feedbackMs.push(performance.now() - startedAt));
      };
      document.addEventListener("pointerover", handlePointerOver, true);

      benchmarkWindow.__PASEO_CSS_HOVER_MEASUREMENT__ = {
        feedbackMs,
        frameGapsMs,
        longTaskDurationsMs,
        stop: () => {
          document.removeEventListener("pointerover", handlePointerOver, true);
          cancelAnimationFrame(frameHandle);
          longTaskObserver?.disconnect();
        },
      };
    },
    { testId: targetTestId },
  );
}

async function readAxNodeCount(cdp: CDPSession): Promise<number> {
  await cdp.send("Accessibility.enable");
  const tree = (await cdp.send("Accessibility.getFullAXTree")) as {
    nodes?: Array<{ ignored?: boolean }>;
  };
  await cdp.send("Accessibility.disable");
  return (tree.nodes ?? []).filter((node) => node.ignored !== true).length;
}

async function measureHoverCase(page: Page, tabCount: number, targetTestId: string) {
  const target = page.getByTestId(targetTestId);
  await target.scrollIntoViewIfNeeded();
  const targetBounds = await target.boundingBox();
  if (!targetBounds) throw new Error(`tab ${targetTestId} has no bounds`);

  for (let index = 0; index < 5; index += 1) {
    await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2);
    await page.mouse.move(targetBounds.x + targetBounds.width / 2, targetBounds.y + 4);
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
  }

  await armHoverMeasurement(page, targetTestId);
  for (let index = 0; index < HOVER_CYCLES; index += 1) {
    await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2);
    await page.mouse.move(targetBounds.x + targetBounds.width / 2, targetBounds.y + 4);
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
  }
  await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

  const browserMetrics = await page.evaluate(() => {
    const benchmarkWindow = window as BenchmarkWindow;
    const measurement = benchmarkWindow.__PASEO_CSS_HOVER_MEASUREMENT__;
    if (!measurement) throw new Error("hover measurement was not armed");
    measurement.stop();
    const profile = benchmarkWindow.__PASEO_RENDER_PROFILE__ ?? [];
    const tabProfile = profile.filter((sample) => sample.id === "WorkspaceDesktopTabsRow");
    const allCommitTimes = new Set(profile.map((sample) => sample.commitTime));
    const tabCommitTimes = new Set(tabProfile.map((sample) => sample.commitTime));
    return {
      feedbackMs: measurement.feedbackMs,
      frameGapsMs: measurement.frameGapsMs,
      longTaskDurationsMs: measurement.longTaskDurationsMs,
      allReactCommits: allCommitTimes.size,
      tabRowReactCommits: tabCommitTimes.size,
      tabRowReactDurationMs: tabProfile.reduce((sum, sample) => sum + sample.actualDuration, 0),
      domNodes: document.querySelectorAll("*").length,
    };
  });
  if (browserMetrics.feedbackMs.length !== HOVER_CYCLES) {
    throw new Error(
      `expected ${HOVER_CYCLES} hover samples for ${tabCount} tabs, received ${browserMetrics.feedbackMs.length}`,
    );
  }
  const cdp = await page.context().newCDPSession(page);
  const axNodes = await readAxNodeCount(cdp);
  await cdp.detach();
  return { ...browserMetrics, axNodes };
}

function buildCaseResult(
  tabCount: number,
  metrics: Awaited<ReturnType<typeof measureHoverCase>>,
): BenchmarkCaseResult {
  const frameSummary = summarizeFrameGaps(metrics.frameGapsMs);
  return {
    id: `tabs-${tabCount}-hover`,
    dimensions: { visibleTabs: tabCount, hoverCycles: HOVER_CYCLES, load: "idle" },
    metrics: {
      feedbackToFrame: durationMetric(metrics.feedbackMs),
      reactCommits: scalarMetric("count", metrics.allReactCommits),
      tabRowReactCommits: scalarMetric("count", metrics.tabRowReactCommits),
      tabRowReactDuration: scalarMetric("ms", metrics.tabRowReactDurationMs),
      longTaskCount: scalarMetric("count", metrics.longTaskDurationsMs.length),
      longTaskDuration: scalarMetric(
        "ms",
        metrics.longTaskDurationsMs.reduce((sum, duration) => sum + duration, 0),
      ),
      delayedFrameIntervals: scalarMetric("count", frameSummary.delayedFrameIntervals),
      estimatedDroppedFrames: scalarMetric("count", frameSummary.estimatedDroppedFrames),
      maxFrameGap: scalarMetric("ms", frameSummary.maxFrameGapMs),
      domNodes: scalarMetric("count", metrics.domNodes),
      axNodes: scalarMetric("count", metrics.axNodes),
    },
  };
}

test("benchmarks Desktop CSS tab hover feedback", async ({ page }) => {
  test.setTimeout(8 * 60_000);
  await page.setViewportSize(VIEWPORT);
  const cases: BenchmarkCaseResult[] = [];
  for (const tabCount of TAB_COUNTS) {
    let workspace: SeededWorkspace | null = null;
    try {
      workspace = await seedWorkspace({ repoPrefix: `desktop-css-hover-${tabCount}-` });
      const agentIds = await createAgents(workspace, tabCount);
      await openAgentTabs(page, workspace.workspaceId, agentIds);
      const targetAgentId = agentIds[0];
      if (!targetAgentId) throw new Error(`missing target agent for ${tabCount} tabs`);
      cases.push(
        buildCaseResult(
          tabCount,
          await measureHoverCase(page, tabCount, `workspace-tab-agent_${targetAgentId}`),
        ),
      );
    } finally {
      await workspace?.cleanup();
    }
  }

  const result = {
    schemaVersion: 1,
    taskId: "desktop-css-interactions",
    generatedAt: new Date().toISOString(),
    metadata: {
      runtime: "chromium-electron-overlay",
      hoverCycles: HOVER_CYCLES,
      viewportWidth: VIEWPORT.width,
      viewportHeight: VIEWPORT.height,
      load: "idle",
      assumedFrameIntervalMs: BENCHMARK_FRAME_INTERVAL_MS,
    },
    cases,
  } satisfies BenchmarkTaskResult;
  const outputPath = process.env.PASEO_BENCHMARK_OUTPUT;
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, serialized);
  if (process.env.PASEO_BENCHMARK_QUIET !== "1") process.stdout.write(serialized);
});
