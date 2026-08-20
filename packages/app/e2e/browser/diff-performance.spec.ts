import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { CDPSession, Locator, Page, TestInfo } from "@playwright/test";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";
import { test, expect } from "../support/fixtures";
import { getServerId } from "../support/helpers/server-id";
import { connectSeedClient } from "../support/helpers/seed-client";
import { createTempGitRepo } from "../support/helpers/workspace";
import { openChangesPanel, waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";
import { DIFF_POC_BASELINE } from "./diff-performance-baseline";

const RUN_DIFF_PERF = process.env.PASEO_DIFF_PERF_E2E === "1";
const diffPerfDescribe = RUN_DIFF_PERF ? test.describe : test.describe.skip;
const LINE_COUNT_PER_FILE = 1_200;
const FILE_PATHS = ["src/large-a.ts", "src/large-b.ts"] as const;
const CPU_SLOWDOWN = Number(process.env.PASEO_DIFF_PERF_CPU_SLOWDOWN ?? 6);
const CHANGES_PREFERENCES_KEY = "@paseo:changes-preferences";
const POC_MEDIAN_FRAME_MS = Number(
  process.env.PASEO_DIFF_POC_MEDIAN_FRAME_MS ?? DIFF_POC_BASELINE.medianFrameMs,
);
const POC_P95_FRAME_MS = Number(
  process.env.PASEO_DIFF_POC_P95_FRAME_MS ?? DIFF_POC_BASELINE.p95FrameMs,
);
const MAX_MEDIAN_FRAME_MS = POC_MEDIAN_FRAME_MS * 1.1;
const MAX_P95_FRAME_MS = POC_P95_FRAME_MS * 1.1;

diffPerfDescribe("Diff canvas performance", () => {
  test("opening a review stays responsive in a large diff", async ({ page }) => {
    test.setTimeout(120_000);
    const repo = await createLargeDiffRepository();
    const client = await connectSeedClient();
    let cdp: CDPSession | null = null;

    try {
      const created = await client.createWorkspace({
        source: { kind: "directory", path: repo.path },
      });
      if (!created.workspace) {
        throw new Error(created.error ?? "Failed to create diff performance workspace");
      }

      await configureUnwrappedUnifiedDiff(page);
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(buildHostWorkspaceRoute(getServerId(), created.workspace.id));
      await waitForWorkspaceTabsVisible(page);
      await openChangesPanel(page);
      await expect(page.getByTestId("git-diff-canvas")).toBeVisible({ timeout: 30_000 });

      cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
      const elapsedMs = await openFirstReviewEditor(page);
      expect(elapsedMs).toBeLessThanOrEqual(200 * CPU_SLOWDOWN);
    } finally {
      await cdp?.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => undefined);
      await cdp?.detach().catch(() => undefined);
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    }
  });

  test("one canvas stays filled through continuous fast scrolling", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const repo = await createLargeDiffRepository();
    const client = await connectSeedClient();
    let cdp: CDPSession | null = null;
    let traceStarted = false;

    try {
      const created = await client.createWorkspace({
        source: { kind: "directory", path: repo.path },
      });
      if (!created.workspace) {
        throw new Error(created.error ?? "Failed to create diff performance workspace");
      }

      await configureUnwrappedUnifiedDiff(page);
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(buildHostWorkspaceRoute(getServerId(), created.workspace.id));
      await waitForWorkspaceTabsVisible(page);
      await openChangesPanel(page);
      await expect(page.getByTestId("git-diff-canvas")).toBeVisible({ timeout: 30_000 });

      await expectSingleCanvasSurface(page);
      cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
      await startChromiumTrace(cdp);
      traceStarted = true;
      await startRendererInstrumentation(page);

      const scrollReports = [];
      const heapUsage = [];
      for (let cycle = 0; cycle < 3; cycle += 1) {
        scrollReports.push(await continuouslyScrollCanvas(page));
        heapUsage.push(await collectHeapUsage(cdp));
      }
      await expectContinuousFramesMatchStableRender(
        page,
        scrollReports.flatMap((report) => report.frameSignatures),
      );
      const frameImages = await captureCanvasAtScrollIntervals(page);
      for (const [frameIndex, frame] of frameImages.entries()) {
        await writeFile(testInfo.outputPath(`diff-canvas-frame-${frameIndex}.png`), frame.image);
        await testInfo.attach(`diff-canvas-frame-${frameIndex}`, {
          body: frame.image,
          contentType: "image/png",
        });
        expect(frame.image.byteLength).toBeGreaterThan(4_000);
      }

      await expectIndependentHorizontalOffsetsSurviveVerticalScrolling(page);
      const renderer = await readRendererInstrumentation(page);
      const measuredCycles = scrollReports.slice(1);
      expect(Math.max(...measuredCycles.map((cycle) => cycle.medianFrameMs))).toBeLessThanOrEqual(
        MAX_MEDIAN_FRAME_MS,
      );
      expect(Math.max(...measuredCycles.map((cycle) => cycle.p95FrameMs))).toBeLessThanOrEqual(
        MAX_P95_FRAME_MS,
      );
      for (const cycle of scrollReports) {
        expect(Math.abs(cycle.maximumScrollTop - cycle.endScrollTop)).toBeLessThanOrEqual(1);
      }
      expect(heapUsage.at(-1)!.usedSize).toBeLessThanOrEqual(
        heapUsage[0]!.usedSize * 1.1 + 1_000_000,
      );
      expect(renderer.addedElements).toBe(0);
      expect(renderer.removedElements).toBe(0);
      expect(renderer.reactCommits).toBeLessThanOrEqual(2);

      await reloadDiffPresentation(page, { layout: "unified", wrapLines: true });
      const wrapped = await measureAdditionalPerformanceScenario(page, cdp, testInfo, "wrapped");
      await reloadDiffPresentation(page, { layout: "split", wrapLines: false });
      const split = await measureAdditionalPerformanceScenario(page, cdp, testInfo, "split");

      const report = {
        cpuSlowdown: CPU_SLOWDOWN,
        pocBaseline: {
          medianFrameMs: POC_MEDIAN_FRAME_MS,
          p95FrameMs: POC_P95_FRAME_MS,
        },
        sourceFiles: FILE_PATHS.length,
        sourceLines: FILE_PATHS.length * LINE_COUNT_PER_FILE,
        scrollReports,
        heapUsage,
        renderer,
        wrapped,
        split,
        canvasPngBytes: frameImages.map((frame) => frame.image.byteLength),
      };
      await attachPerformanceReport(testInfo, report);
      await stopChromiumTrace(cdp, testInfo);
      traceStarted = false;

      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    } finally {
      if (cdp && traceStarted) {
        await stopChromiumTrace(cdp, testInfo).catch(() => undefined);
      }
      await cdp?.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => undefined);
      await cdp?.detach().catch(() => undefined);
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    }
  });
});

async function measureAdditionalPerformanceScenario(
  page: Page,
  cdp: CDPSession,
  testInfo: TestInfo,
  name: "wrapped" | "split",
) {
  await expectSingleCanvasSurface(page);
  await startRendererInstrumentation(page);
  const scrollReports = [];
  const heapUsage = [];
  for (let cycle = 0; cycle < 3; cycle += 1) {
    scrollReports.push(await continuouslyScrollCanvas(page));
    heapUsage.push(await collectHeapUsage(cdp));
  }
  await expectContinuousFramesMatchStableRender(
    page,
    scrollReports.flatMap((report) => report.frameSignatures),
  );
  const frames = await captureCanvasAtScrollIntervals(page);
  for (const [index, frame] of frames.entries()) {
    await writeFile(testInfo.outputPath(`diff-canvas-${name}-frame-${index}.png`), frame.image);
    await testInfo.attach(`diff-canvas-${name}-frame-${index}`, {
      body: frame.image,
      contentType: "image/png",
    });
    expect(frame.image.byteLength).toBeGreaterThan(4_000);
  }
  const measuredCycles = scrollReports.slice(1);
  expect(Math.max(...measuredCycles.map((cycle) => cycle.medianFrameMs))).toBeLessThanOrEqual(
    MAX_MEDIAN_FRAME_MS,
  );
  expect(Math.max(...measuredCycles.map((cycle) => cycle.p95FrameMs))).toBeLessThanOrEqual(
    MAX_P95_FRAME_MS,
  );
  for (const cycle of scrollReports) {
    expect(Math.abs(cycle.maximumScrollTop - cycle.endScrollTop)).toBeLessThanOrEqual(1);
  }
  expect(heapUsage.at(-1)!.usedSize).toBeLessThanOrEqual(heapUsage[0]!.usedSize * 1.1 + 1_000_000);
  const renderer = await readRendererInstrumentation(page);
  expect(renderer.addedElements).toBe(0);
  expect(renderer.removedElements).toBe(0);
  expect(renderer.reactCommits).toBeLessThanOrEqual(2);
  return {
    scrollReports,
    heapUsage,
    renderer,
    canvasPngBytes: frames.map((frame) => frame.image.byteLength),
  };
}

async function reloadDiffPresentation(
  page: Page,
  requestedPresentation: { layout: "unified" | "split"; wrapLines: boolean },
): Promise<void> {
  await page.evaluate(
    ({ preferencesKey, presentation }) => {
      const current = JSON.parse(localStorage.getItem(preferencesKey) ?? "{}") as object;
      localStorage.setItem(preferencesKey, JSON.stringify({ ...current, ...presentation }));
    },
    { preferencesKey: CHANGES_PREFERENCES_KEY, presentation: requestedPresentation },
  );
  await page.reload();
  await waitForWorkspaceTabsVisible(page);
  await openChangesPanel(page);
  await expect(page.getByTestId("git-diff-canvas")).toBeVisible({ timeout: 30_000 });
}

async function createLargeDiffRepository() {
  const repo = await createTempGitRepo("diff-perf-", {
    files: FILE_PATHS.map((filePath, fileIndex) => ({
      path: filePath,
      content: `export const baseline_${fileIndex} = 0;\n`,
    })),
  });
  for (const [fileIndex, filePath] of FILE_PATHS.entries()) {
    const generatedLines = Array.from(
      { length: LINE_COUNT_PER_FILE },
      (_, lineIndex) =>
        `export const generated_${fileIndex}_${lineIndex} = "${lineIndex}-${"wide".repeat(16)}";`,
    ).join("\n");
    await writeFile(
      path.join(repo.path, filePath),
      `export const baseline_${fileIndex} = 1;\n${generatedLines}\n`,
    );
  }
  return repo;
}

async function configureUnwrappedUnifiedDiff(page: Page): Promise<void> {
  await page.addInitScript(
    ({ preferencesKey }) => {
      const scope = globalThis as typeof globalThis & {
        __PASEO_DIFF_REACT_STATS__?: { commits: number };
      };
      scope.__PASEO_DIFF_REACT_STATS__ = { commits: 0 };
      if (!localStorage.getItem(preferencesKey)) {
        localStorage.setItem(
          preferencesKey,
          JSON.stringify({
            layout: "unified",
            viewMode: "flat",
            wrapLines: false,
            hideWhitespace: false,
          }),
        );
      }
    },
    { preferencesKey: CHANGES_PREFERENCES_KEY },
  );
}

async function openFirstReviewEditor(page: Page): Promise<number> {
  const body = page.getByTestId("diff-file-0-body");
  const canvas = page.getByTestId("git-diff-canvas");
  const [bodyBounds, fontSize] = await Promise.all([
    body.boundingBox(),
    canvas.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ]);
  if (!bodyBounds) throw new Error("Expanded diff body has no bounds");
  const lineHeight = Math.round(fontSize * 1.5);
  const startedAt = performance.now();
  await page.mouse.click(bodyBounds.x + 120, bodyBounds.y + lineHeight * 1.5);
  await expect(page.getByTestId("inline-review-editor")).toBeVisible();
  return performance.now() - startedAt;
}

async function expectSingleCanvasSurface(page: Page): Promise<void> {
  await expect(page.locator("canvas")).toHaveCount(1);
  await expect(page.locator('[data-testid^="diff-code-row-"]')).toHaveCount(0);
  const elementCount = await page
    .getByTestId("git-diff-canvas-root")
    .evaluate((root) => root.querySelectorAll("*").length);
  expect(elementCount).toBeLessThan(150);
}

async function continuouslyScrollCanvas(page: Page): Promise<{
  medianFrameMs: number;
  p95FrameMs: number;
  maximumFrameMs: number;
  slowFrames: number;
  endScrollTop: number;
  maximumScrollTop: number;
  frameSignatures: Array<{ scrollTop: number; signature: number }>;
}> {
  return page.getByTestId("git-diff-scroll").evaluate(async (element) => {
    const scroll = element as HTMLElement;
    const maximumScrollTop = scroll.scrollHeight - scroll.clientHeight;
    scroll.scrollTop = 0;
    const frameDurations: number[] = [];
    const frameSignatures: Array<{ scrollTop: number; signature: number }> = [];
    let previousFrame = performance.now();

    for (let step = 1; step <= 90; step += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const now = performance.now();
      frameDurations.push(now - previousFrame);
      previousFrame = now;
      scroll.scrollTop = (maximumScrollTop * step) / 90;
      scroll.dispatchEvent(new Event("scroll", { bubbles: false }));
      if (step % 10 === 0) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const canvas = document.querySelector<HTMLCanvasElement>(
          '[data-testid="git-diff-canvas"]',
        )!;
        frameSignatures.push({
          scrollTop: scroll.scrollTop,
          signature: canvasSignature(canvas, scroll),
        });
        previousFrame = performance.now();
      }
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const ordered = [...frameDurations].sort((left, right) => left - right);
    const percentile = (fraction: number) =>
      ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] ?? 0;
    return {
      medianFrameMs: percentile(0.5),
      p95FrameMs: percentile(0.95),
      maximumFrameMs: Math.max(...frameDurations),
      slowFrames: frameDurations.filter((duration) => duration > 50).length,
      endScrollTop: scroll.scrollTop,
      maximumScrollTop,
      frameSignatures,
    };

    function canvasSignature(canvasElement: HTMLCanvasElement, scrollElement: HTMLElement): number {
      const sample = document.createElement("canvas");
      sample.width = 64;
      sample.height = 36;
      const context = sample.getContext("2d")!;
      const canvasCssHeight = Number.parseFloat(canvasElement.style.height);
      const canvasTop = Number.parseFloat(canvasElement.style.top);
      const pixelRatio = canvasElement.height / canvasCssHeight;
      const sourceY = (scrollElement.scrollTop - canvasTop) * pixelRatio;
      context.drawImage(
        canvasElement,
        0,
        sourceY,
        canvasElement.width,
        scrollElement.clientHeight * pixelRatio,
        0,
        0,
        sample.width,
        sample.height,
      );
      const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
      let hash = 2166136261;
      for (const value of pixels) hash = Math.imul(hash ^ value, 16777619);
      return hash >>> 0;
    }
  });
}

interface CapturedCanvasFrame {
  scrollTop: number;
  image: Buffer;
}

async function captureCanvasAtScrollIntervals(page: Page): Promise<CapturedCanvasFrame[]> {
  const scroll = page.getByTestId("git-diff-scroll");
  const frames: CapturedCanvasFrame[] = [];
  for (let step = 0; step <= 8; step += 1) {
    const scrollTop = await scroll.evaluate(async (element, progress) => {
      const scrollElement = element as HTMLElement;
      scrollElement.scrollTop =
        (scrollElement.scrollHeight - scrollElement.clientHeight) * Number(progress);
      scrollElement.dispatchEvent(new Event("scroll", { bubbles: false }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return scrollElement.scrollTop;
    }, step / 8);
    frames.push({ scrollTop, image: await scroll.screenshot() });
  }
  return frames;
}

async function expectContinuousFramesMatchStableRender(
  page: Page,
  samples: Array<{ scrollTop: number; signature: number }>,
): Promise<void> {
  const stable = await page.getByTestId("git-diff-scroll").evaluate(async (element, frames) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="git-diff-canvas"]')!;
    const signatures: number[] = [];
    for (const frame of frames) {
      element.scrollTop = frame.scrollTop;
      element.dispatchEvent(new Event("scroll", { bubbles: false }));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const sample = document.createElement("canvas");
      sample.width = 64;
      sample.height = 36;
      const context = sample.getContext("2d")!;
      drawVisibleCanvas(context, canvas, element as HTMLElement, sample.width, sample.height);
      const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
      let hash = 2166136261;
      for (const value of pixels) hash = Math.imul(hash ^ value, 16777619);
      signatures.push(hash >>> 0);
    }
    return signatures;

    function drawVisibleCanvas(
      context: CanvasRenderingContext2D,
      canvasElement: HTMLCanvasElement,
      scroll: HTMLElement,
      width: number,
      height: number,
    ): void {
      const canvasCssHeight = Number.parseFloat(canvasElement.style.height);
      const canvasTop = Number.parseFloat(canvasElement.style.top);
      const pixelRatio = canvasElement.height / canvasCssHeight;
      const sourceY = (scroll.scrollTop - canvasTop) * pixelRatio;
      context.drawImage(
        canvasElement,
        0,
        sourceY,
        canvasElement.width,
        scroll.clientHeight * pixelRatio,
        0,
        0,
        width,
        height,
      );
    }
  }, samples);
  expect(stable).toEqual(samples.map((sample) => sample.signature));
}

async function expectIndependentHorizontalOffsetsSurviveVerticalScrolling(
  page: Page,
): Promise<void> {
  const first = page.getByTestId("diff-file-0-horizontal-scroll");
  const second = page.getByTestId("diff-file-1-horizontal-scroll");
  const firstOffset = await setHorizontalOffset(first, 240);
  const secondOffset = await setHorizontalOffset(second, 120);
  expect(firstOffset).not.toBe(secondOffset);
  await page.getByTestId("git-diff-scroll").evaluate(async (element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: false }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: false }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await expect.poll(() => first.evaluate((element) => element.scrollLeft)).toBe(firstOffset);
  await expect.poll(() => second.evaluate((element) => element.scrollLeft)).toBe(secondOffset);
}

async function setHorizontalOffset(locator: Locator, offset: number) {
  return locator.evaluate(async (element, nextOffset) => {
    element.scrollLeft = nextOffset;
    element.dispatchEvent(new Event("scroll", { bubbles: false }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return element.scrollLeft;
  }, offset);
}

async function startRendererInstrumentation(page: Page): Promise<void> {
  await page.getByTestId("git-diff-canvas-root").evaluate((root) => {
    const scope = globalThis as typeof globalThis & {
      __PASEO_DIFF_REACT_STATS__?: { commits: number };
      __PASEO_DIFF_RENDERER_STATS__?: {
        initialCommits: number;
        addedElements: number;
        removedElements: number;
      };
    };
    const reactStats = scope.__PASEO_DIFF_REACT_STATS__ ?? { commits: 0, unmounts: 0 };
    const stats = {
      initialCommits: reactStats.commits,
      addedElements: 0,
      removedElements: 0,
    };
    scope.__PASEO_DIFF_RENDERER_STATS__ = stats;
    new MutationObserver((records) => {
      for (const record of records) {
        stats.addedElements += Array.from(record.addedNodes).filter(
          (node) => node.nodeType === Node.ELEMENT_NODE,
        ).length;
        stats.removedElements += Array.from(record.removedNodes).filter(
          (node) => node.nodeType === Node.ELEMENT_NODE,
        ).length;
      }
    }).observe(root, { childList: true, subtree: true });
  });
}

async function readRendererInstrumentation(page: Page): Promise<{
  reactCommits: number;
  addedElements: number;
  removedElements: number;
}> {
  return page.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __PASEO_DIFF_REACT_STATS__?: { commits: number };
      __PASEO_DIFF_RENDERER_STATS__?: {
        initialCommits: number;
        addedElements: number;
        removedElements: number;
      };
    };
    const react = scope.__PASEO_DIFF_REACT_STATS__!;
    const renderer = scope.__PASEO_DIFF_RENDERER_STATS__!;
    return {
      reactCommits: react.commits - renderer.initialCommits,
      addedElements: renderer.addedElements,
      removedElements: renderer.removedElements,
    };
  });
}

async function collectHeapUsage(cdp: CDPSession): Promise<{ usedSize: number; totalSize: number }> {
  await cdp.send("HeapProfiler.collectGarbage");
  return cdp.send("Runtime.getHeapUsage");
}

async function startChromiumTrace(cdp: CDPSession): Promise<void> {
  await cdp.send("Tracing.start", {
    categories: [
      "devtools.timeline",
      "v8.execute",
      "blink.user_timing",
      "disabled-by-default-v8.cpu_profiler",
    ].join(","),
    transferMode: "ReturnAsStream",
  });
}

async function stopChromiumTrace(cdp: CDPSession, testInfo: TestInfo): Promise<void> {
  const completed = new Promise<string>((resolve, reject) => {
    cdp.once("Tracing.tracingComplete", ({ stream }) => {
      if (stream) resolve(stream);
      else reject(new Error("Chromium trace completed without a stream"));
    });
  });
  await cdp.send("Tracing.end");
  const stream = await completed;
  const chunks: string[] = [];
  let eof = false;
  while (!eof) {
    const chunk = await cdp.send("IO.read", { handle: stream });
    chunks.push(chunk.data);
    eof = chunk.eof;
  }
  await cdp.send("IO.close", { handle: stream });
  const trace = chunks.join("");
  await writeFile(testInfo.outputPath("diff-canvas-chromium-trace.json"), trace);
  await testInfo.attach("diff-canvas-chromium-trace", {
    body: trace,
    contentType: "application/json",
  });
}

async function attachPerformanceReport(
  testInfo: TestInfo,
  report: Record<string, unknown>,
): Promise<void> {
  await testInfo.attach("diff-canvas-performance", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
}
