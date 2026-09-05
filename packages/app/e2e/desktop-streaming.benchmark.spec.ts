import { writeFile } from "node:fs/promises";
import type { Browser, BrowserContext, CDPSession, Page } from "@playwright/test";
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
import { test } from "./support/fixtures";
import {
  buildMarkdownTextOracle,
  MARKDOWN_ORACLE_RELEASE,
  MARKDOWN_WORKLOADS,
  type MarkdownTextOracle,
  type MarkdownWorkload,
} from "./desktop-markdown-oracle";
import { buildCreateAgentPreferences, buildSeededHost } from "./support/helpers/daemon-registry";
import { getE2EDaemonPort } from "./support/helpers/daemon-port";
import { buildAgentRoute } from "./support/helpers/mock-agent";
import { getServerId } from "./support/helpers/server-id";
import { seedWorkspace, type SeededWorkspace } from "./support/helpers/seed-client";

const STREAM_MESSAGE_SIZES_BYTES = [64 * 1024, 256 * 1024, 1024 * 1024] as const;
const CHUNK_BYTES = 512;
const DEFAULT_MEASURED_RUNS = 5;
const FEEDBACK_TARGET_DELAY_MS = 25;
const FEEDBACK_SAMPLE_INTERVAL_MS = 100;
const VIEWPORT = { width: 1440, height: 900 };
const isMarkdownBenchmark = process.env.PASEO_MARKDOWN_BENCHMARK === "1";

interface StreamBenchmarkCase {
  workload: MarkdownWorkload;
  messageBytes: number;
}

const DEFAULT_MARKDOWN_CASES: StreamBenchmarkCase[] = MARKDOWN_WORKLOADS.flatMap((workload) =>
  STREAM_MESSAGE_SIZES_BYTES.map((messageBytes) => ({ workload, messageBytes })),
);

function parseMeasuredRuns(): number {
  const configured = Number(process.env.PASEO_MARKDOWN_BENCHMARK_RUNS ?? DEFAULT_MEASURED_RUNS);
  if (!Number.isInteger(configured) || configured <= 0) {
    throw new Error("PASEO_MARKDOWN_BENCHMARK_RUNS must be a positive integer");
  }
  return configured;
}

function isMarkdownWorkload(value: string): value is MarkdownWorkload {
  return MARKDOWN_WORKLOADS.some((workload) => workload === value);
}

function parseMarkdownCases(): StreamBenchmarkCase[] {
  const configured: string | undefined = process.env.PASEO_MARKDOWN_BENCHMARK_CASES;
  if (!configured) {
    return DEFAULT_MARKDOWN_CASES;
  }
  return configured.split(",").map((entry) => {
    const [workloadValue, messageBytesValue] = entry.split(":");
    const messageBytes = Number(messageBytesValue);
    if (!workloadValue || !isMarkdownWorkload(workloadValue)) {
      throw new Error(`unknown Markdown benchmark workload: ${workloadValue ?? ""}`);
    }
    if (!Number.isInteger(messageBytes) || messageBytes <= 0 || messageBytes > 1024 * 1024) {
      throw new Error(`invalid Markdown benchmark message size: ${messageBytesValue ?? ""}`);
    }
    return { workload: workloadValue, messageBytes };
  });
}

const MEASURED_RUNS = isMarkdownBenchmark ? parseMeasuredRuns() : DEFAULT_MEASURED_RUNS;
const STREAM_CASES: StreamBenchmarkCase[] = isMarkdownBenchmark
  ? parseMarkdownCases()
  : STREAM_MESSAGE_SIZES_BYTES.map((messageBytes) => ({
      workload: "plain_unbroken",
      messageBytes,
    }));

interface FlushProfileSample {
  agentId: string;
  eventCount: number;
  assistantChunkCount: number;
  assistantBytes: number;
  maxContiguousAssistantRun: number;
  reducerDurationMs: number;
  completedAt: number;
}

interface RenderProfileSample {
  actualDuration: number;
  commitTime: number;
}

interface MarkdownParseProfileSample {
  sourceChars: number;
  durationMs: number;
  tokens: number;
}

interface HighlightProfileSample {
  codeChars: number;
  durationMs: number;
  cacheHit: boolean;
  lines: number;
  tokens: number;
}

interface StreamProbe {
  startedAt: number;
  feedbackTargetAt: number;
  feedbackTimer: number;
  feedbackDelays: number[];
  frameHandle: number;
  previousFrameAt: number;
  frameGaps: number[];
  longTasks: PerformanceEntry[];
  observer: PerformanceObserver | null;
  feedbackButton: HTMLButtonElement;
}

interface BrowserMemory {
  usedJSHeapSize?: number;
}

interface BenchmarkWindow extends Window {
  __PASEO_AGENT_STREAM_FLUSH_PROFILE__?: FlushProfileSample[];
  __PASEO_RENDER_PROFILE__?: RenderProfileSample[];
  __PASEO_RESET_RENDER_PROFILE__?: () => void;
  __PASEO_STREAM_BENCHMARK_PROBE__?: StreamProbe;
  __PASEO_MARKDOWN_PARSE_PROFILE__?: MarkdownParseProfileSample[];
  __PASEO_HIGHLIGHT_PROFILE__?: HighlightProfileSample[];
}

interface StreamRunSample {
  endToEndMs: number;
  reducerTotalMs: number;
  reducerFlushDurationsMs: number[];
  chunksPerFlush: number[];
  bytesPerFlush: number[];
  maxContiguousRunPerFlush: number[];
  flushCount: number;
  clientChunkCount: number;
  reactCommits: number;
  reactDurationMs: number;
  longTaskCount: number;
  longTaskDurationMs: number;
  frameGapsMs: number[];
  feedbackDelayMs: number;
  feedbackDelayMaxMs: number;
  feedbackSamples: number;
  heapDeltaBytes: number;
  postGcHeapBytes: number;
  markdownBytes: number;
  markdownParseCalls: number;
  markdownParseDurationMs: number;
  highlightCalls: number;
  highlightCacheHits: number;
  highlightDurationMs: number;
  highlightedTokens: number;
  assistantDomNodes: number;
  axNodes: number;
  axNonIgnoredNodes: number;
  renderedTextHash: string;
  expandedRenderedTextHash: string;
}

function durationMetric(samples: number[]): BenchmarkMetricResult {
  const summary = summarizeSamples(samples);
  return {
    unit: "ms",
    values: { p50: summary.p50, p95: summary.p95 },
    samples: summary.samples,
  };
}

function countMetric(samples: number[]): BenchmarkMetricResult {
  const summary = summarizeSamples(samples);
  return {
    unit: "count",
    values: { p50: summary.p50, p95: summary.p95 },
    samples: summary.samples,
  };
}

function bytesMetric(samples: number[]): BenchmarkMetricResult {
  const summary = summarizeSamples(samples);
  return {
    unit: "bytes",
    values: { p50: summary.p50, p95: summary.p95 },
    samples: summary.samples,
  };
}

async function seedBenchmarkStorage(context: BrowserContext): Promise<void> {
  const serverId = getServerId();
  const daemon = buildSeededHost({
    serverId,
    endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
    nowIso: new Date().toISOString(),
  });
  const preferences = buildCreateAgentPreferences();
  await context.addInitScript(
    ({ seededDaemon, seededPreferences }) => {
      localStorage.setItem("@paseo:e2e", "1");
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seededDaemon]));
      localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(seededPreferences));
      localStorage.removeItem("@paseo:settings");
      (window as BenchmarkWindow).__PASEO_AGENT_STREAM_FLUSH_PROFILE__ = [];
      (window as BenchmarkWindow).__PASEO_MARKDOWN_PARSE_PROFILE__ = [];
      (window as BenchmarkWindow).__PASEO_HIGHLIGHT_PROFILE__ = [];
    },
    { seededDaemon: daemon, seededPreferences: preferences },
  );
}

async function openEmptyAgent(
  page: Page,
  workspace: SeededWorkspace,
  agentId: string,
): Promise<void> {
  const route = buildAgentRoute(workspace.workspaceId, agentId);
  await page.goto(`${route}${route.includes("?") ? "&" : "?"}renderProfile=1`);
  await page.waitForURL(
    (url) =>
      url.pathname.includes("/workspace/") &&
      !url.searchParams.has("open") &&
      url.searchParams.get("renderProfile") === "1",
    { timeout: 60_000 },
  );
  await page.getByTestId(`workspace-tab-agent_${agentId}`).waitFor({ timeout: 60_000 });
  await page.locator('[data-testid="agent-chat-scroll"]:visible').waitFor({ timeout: 60_000 });
}

async function readHeap(page: Page): Promise<number> {
  return page.evaluate(
    () => (performance as Performance & { memory?: BrowserMemory }).memory?.usedJSHeapSize ?? 0,
  );
}

async function armStreamProbe(page: Page): Promise<void> {
  await page.evaluate(
    ({ feedbackTargetDelayMs, feedbackSampleIntervalMs }) => {
      const state = window as BenchmarkWindow;
      state.__PASEO_AGENT_STREAM_FLUSH_PROFILE__ = [];
      state.__PASEO_RESET_RENDER_PROFILE__?.();
      state.__PASEO_MARKDOWN_PARSE_PROFILE__?.splice(0);
      state.__PASEO_HIGHLIGHT_PROFILE__?.splice(0);

      const startedAt = performance.now();
      const longTasks: PerformanceEntry[] = [];
      const observer =
        typeof PerformanceObserver === "undefined"
          ? null
          : new PerformanceObserver((list) => longTasks.push(...list.getEntries()));
      try {
        observer?.observe({ type: "longtask" });
      } catch {
        observer?.disconnect();
      }

      const feedbackButton = document.createElement("button");
      feedbackButton.type = "button";
      feedbackButton.style.cssText =
        "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;pointer-events:none";
      document.body.appendChild(feedbackButton);

      const probe: StreamProbe = {
        startedAt,
        feedbackTargetAt: startedAt + feedbackTargetDelayMs,
        feedbackTimer: 0,
        feedbackDelays: [],
        frameHandle: 0,
        previousFrameAt: startedAt,
        frameGaps: [],
        longTasks,
        observer,
        feedbackButton,
      };
      feedbackButton.addEventListener("click", () => {
        const now = performance.now();
        probe.feedbackDelays.push(Math.max(0, now - probe.feedbackTargetAt));
        probe.feedbackTargetAt = now + feedbackSampleIntervalMs;
        probe.feedbackTimer = window.setTimeout(
          () => feedbackButton.click(),
          feedbackSampleIntervalMs,
        );
      });
      probe.feedbackTimer = window.setTimeout(() => feedbackButton.click(), feedbackTargetDelayMs);

      const recordFrame = () => {
        const now = performance.now();
        probe.frameGaps.push(now - probe.previousFrameAt);
        probe.previousFrameAt = now;
        probe.frameHandle = window.requestAnimationFrame(recordFrame);
      };
      probe.frameHandle = window.requestAnimationFrame(recordFrame);
      state.__PASEO_STREAM_BENCHMARK_PROBE__ = probe;
    },
    {
      feedbackTargetDelayMs: FEEDBACK_TARGET_DELAY_MS,
      feedbackSampleIntervalMs: FEEDBACK_SAMPLE_INTERVAL_MS,
    },
  );
}

async function waitForAssistantBytes(page: Page, expectedBytes: number): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      ((window as BenchmarkWindow).__PASEO_AGENT_STREAM_FLUSH_PROFILE__ ?? []).reduce(
        (sum, sample) => sum + sample.assistantBytes,
        0,
      ) >= expected,
    expectedBytes,
    { timeout: 60_000 },
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function finishStreamProbe(
  page: Page,
  input: {
    expectedBytes: number;
    heapBefore: number;
    verifyPlainText: boolean;
    markdownOracle: MarkdownTextOracle | null;
  },
): Promise<StreamRunSample> {
  const heapAfter = await readHeap(page);
  return page.evaluate(
    async ({ expectedBytes, heapBefore, heapAfterValue, verifyPlainText, markdownOracle }) => {
      async function assertMarkdownRendering(
        assistantMessages: NodeListOf<HTMLElement>,
        renderedText: string,
        oracle: MarkdownTextOracle | null,
      ): Promise<void> {
        if (!oracle) return;
        const normalizedRenderedText = renderedText.replace(/[•◦▪\s]+/gu, "");
        const normalizedDigest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(normalizedRenderedText),
        );
        const normalizedHash = Array.from(new Uint8Array(normalizedDigest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        const renderedAnchorCount = Array.from(assistantMessages).reduce(
          (sum, element) => sum + element.querySelectorAll("a").length,
          0,
        );
        if (
          normalizedRenderedText === oracle.expectedNormalizedText &&
          normalizedHash === oracle.expectedNormalizedTextHash &&
          renderedAnchorCount === oracle.expectedAnchorCount
        ) {
          return;
        }

        let mismatchIndex = 0;
        while (
          mismatchIndex < normalizedRenderedText.length &&
          mismatchIndex < oracle.expectedNormalizedText.length &&
          normalizedRenderedText[mismatchIndex] === oracle.expectedNormalizedText[mismatchIndex]
        ) {
          mismatchIndex += 1;
        }
        const previewStart = Math.max(0, mismatchIndex - 40);
        const previewEnd = mismatchIndex + 80;
        throw new Error(
          [
            `Markdown oracle ${oracle.release} rejected rendered output`,
            `text chars ${normalizedRenderedText.length}/${oracle.expectedNormalizedTextChars}`,
            `text hash ${normalizedHash}/${oracle.expectedNormalizedTextHash}`,
            `anchors ${renderedAnchorCount}/${oracle.expectedAnchorCount}`,
            `mismatch at ${mismatchIndex}`,
            `actual ${JSON.stringify(normalizedRenderedText.slice(previewStart, previewEnd))}`,
            `expected ${JSON.stringify(oracle.expectedNormalizedText.slice(previewStart, previewEnd))}`,
          ].join("; "),
        );
      }

      const state = window as BenchmarkWindow;
      const probe = state.__PASEO_STREAM_BENCHMARK_PROBE__;
      if (!probe) throw new Error("stream benchmark probe was not armed");
      probe.observer?.disconnect();
      window.cancelAnimationFrame(probe.frameHandle);
      window.clearTimeout(probe.feedbackTimer);
      probe.feedbackButton.remove();

      const flushes = (state.__PASEO_AGENT_STREAM_FLUSH_PROFILE__ ?? []).filter(
        (sample) => sample.assistantChunkCount > 0,
      );
      const renderSamples = state.__PASEO_RENDER_PROFILE__ ?? [];
      const lastCommitAt = Math.max(
        probe.startedAt,
        ...renderSamples.map((sample) => sample.commitTime),
      );
      if (probe.feedbackDelays.length === 0) {
        probe.feedbackDelays.push(Math.max(0, performance.now() - probe.feedbackTargetAt));
      }
      const sortedFeedbackDelays = [...probe.feedbackDelays].sort((left, right) => left - right);
      const feedbackP95Index = Math.max(0, Math.ceil(sortedFeedbackDelays.length * 0.95) - 1);
      const feedbackDelayP95 = sortedFeedbackDelays[feedbackP95Index] ?? 0;
      const assistantMessages = document.querySelectorAll<HTMLElement>(
        '[data-testid="assistant-message"]',
      );
      const latestAssistant = assistantMessages.item(assistantMessages.length - 1);
      const markdownText = latestAssistant?.textContent ?? "";
      let markdownBytes = 0;
      while (markdownText.charCodeAt(markdownBytes) === 120) markdownBytes += 1;
      if (verifyPlainText && markdownBytes !== expectedBytes) {
        throw new Error(
          `assistant Markdown has ${markdownBytes} streamed bytes, expected ${expectedBytes}`,
        );
      }
      if (!verifyPlainText) {
        markdownBytes = flushes.reduce((sum, sample) => sum + sample.assistantBytes, 0);
      }

      const renderedText = Array.from(assistantMessages)
        .map((element) => element.textContent ?? "")
        .join("");
      await assertMarkdownRendering(assistantMessages, renderedText, markdownOracle);
      const renderedBytes = new TextEncoder().encode(renderedText);
      const renderedDigest = await crypto.subtle.digest("SHA-256", renderedBytes);
      const renderedTextHash = Array.from(new Uint8Array(renderedDigest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const markdownParseProfile = state.__PASEO_MARKDOWN_PARSE_PROFILE__ ?? [];
      const highlightProfile = state.__PASEO_HIGHLIGHT_PROFILE__ ?? [];

      const commitTimes = new Set(renderSamples.map((sample) => sample.commitTime));
      return {
        endToEndMs: lastCommitAt - probe.startedAt,
        reducerTotalMs: flushes.reduce((sum, sample) => sum + sample.reducerDurationMs, 0),
        reducerFlushDurationsMs: flushes.map((sample) => sample.reducerDurationMs),
        chunksPerFlush: flushes.map((sample) => sample.assistantChunkCount),
        bytesPerFlush: flushes.map((sample) => sample.assistantBytes),
        maxContiguousRunPerFlush: flushes.map((sample) => sample.maxContiguousAssistantRun),
        flushCount: flushes.length,
        clientChunkCount: flushes.reduce((sum, sample) => sum + sample.assistantChunkCount, 0),
        reactCommits: commitTimes.size,
        reactDurationMs: renderSamples.reduce((sum, sample) => sum + sample.actualDuration, 0),
        longTaskCount: probe.longTasks.length,
        longTaskDurationMs: probe.longTasks.reduce((sum, entry) => sum + entry.duration, 0),
        frameGapsMs: probe.frameGaps,
        feedbackDelayMs: feedbackDelayP95,
        feedbackDelayMaxMs: sortedFeedbackDelays.at(-1) ?? 0,
        feedbackSamples: sortedFeedbackDelays.length,
        heapDeltaBytes: heapAfterValue - heapBefore,
        postGcHeapBytes: 0,
        markdownBytes,
        markdownParseCalls: markdownParseProfile.length,
        markdownParseDurationMs: markdownParseProfile.reduce(
          (sum, sample) => sum + sample.durationMs,
          0,
        ),
        highlightCalls: highlightProfile.length,
        highlightCacheHits: highlightProfile.filter((sample) => sample.cacheHit).length,
        highlightDurationMs: highlightProfile.reduce((sum, sample) => sum + sample.durationMs, 0),
        highlightedTokens: highlightProfile.reduce((sum, sample) => sum + sample.tokens, 0),
        assistantDomNodes: Array.from(assistantMessages).reduce(
          (sum, element) => sum + element.querySelectorAll("*").length + 1,
          0,
        ),
        axNodes: 0,
        axNonIgnoredNodes: 0,
        renderedTextHash,
        expandedRenderedTextHash: renderedTextHash,
      };
    },
    {
      expectedBytes: input.expectedBytes,
      heapBefore: input.heapBefore,
      heapAfterValue: heapAfter,
      verifyPlainText: input.verifyPlainText,
      markdownOracle: input.markdownOracle,
    },
  );
}

async function readAxNodeCounts(
  cdp: CDPSession,
): Promise<{ axNodes: number; axNonIgnoredNodes: number }> {
  await cdp.send("Accessibility.enable");
  const tree = (await cdp.send("Accessibility.getFullAXTree")) as {
    nodes?: Array<{ ignored?: boolean }>;
  };
  await cdp.send("Accessibility.disable");
  const nodes = tree.nodes ?? [];
  return {
    axNodes: nodes.length,
    axNonIgnoredNodes: nodes.filter((node) => node.ignored !== true).length,
  };
}

async function expandLongAssistantMessageAndReadHash(
  page: Page,
  collapsedHash: string,
): Promise<string> {
  const expandButton = page.getByTestId("assistant-message-expand").last();
  if ((await expandButton.count()) === 0) {
    return collapsedHash;
  }

  await expandButton.click({ timeout: 60_000 });
  await expandButton.waitFor({ state: "detached", timeout: 60_000 });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  return page.evaluate(async () => {
    const assistantMessages = document.querySelectorAll<HTMLElement>(
      '[data-testid="assistant-message"]',
    );
    const renderedText = Array.from(assistantMessages)
      .map((element) => element.textContent ?? "")
      .join("");
    const renderedBytes = new TextEncoder().encode(renderedText);
    const renderedDigest = await crypto.subtle.digest("SHA-256", renderedBytes);
    return Array.from(new Uint8Array(renderedDigest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  });
}

function buildCase(input: {
  workload: MarkdownWorkload;
  messageBytes: number;
  samples: StreamRunSample[];
  markdownOracle: MarkdownTextOracle | null;
}): BenchmarkCaseResult {
  const { workload, messageBytes, samples, markdownOracle } = input;
  const reducerFlushDurations = samples.flatMap((sample) => sample.reducerFlushDurationsMs);
  const chunksPerFlush = samples.flatMap((sample) => sample.chunksPerFlush);
  const bytesPerFlush = samples.flatMap((sample) => sample.bytesPerFlush);
  const maxRuns = samples.flatMap((sample) => sample.maxContiguousRunPerFlush);
  const frameSummaries = samples.map((sample) => summarizeFrameGaps(sample.frameGapsMs));
  const renderedTextHashes = new Set(samples.map((sample) => sample.renderedTextHash));
  if (renderedTextHashes.size !== 1) {
    throw new Error(`${workload}:${messageBytes} produced inconsistent rendered text hashes`);
  }
  const expandedRenderedTextHashes = new Set(
    samples.map((sample) => sample.expandedRenderedTextHash),
  );
  if (expandedRenderedTextHashes.size !== 1) {
    throw new Error(
      `${workload}:${messageBytes} produced inconsistent expanded rendered text hashes`,
    );
  }
  return {
    id: `${workload}-${messageBytes}-bytes`,
    dimensions: {
      workload,
      messageBytes,
      chunkBytes: CHUNK_BYTES,
      providerChunkCount: Math.ceil(messageBytes / CHUNK_BYTES),
      measuredRuns: samples.length,
      assumedFrameIntervalMs: BENCHMARK_FRAME_INTERVAL_MS,
      renderedTextHash: samples[0]?.renderedTextHash ?? "missing",
      expandedRenderedTextHash: samples[0]?.expandedRenderedTextHash ?? "missing",
      markdownOracleRelease: markdownOracle?.release ?? null,
      expectedNormalizedTextHash: markdownOracle?.expectedNormalizedTextHash ?? null,
      expectedAnchorCount: markdownOracle?.expectedAnchorCount ?? null,
    },
    metrics: {
      endToEnd: durationMetric(samples.map((sample) => sample.endToEndMs)),
      reducerTotal: durationMetric(samples.map((sample) => sample.reducerTotalMs)),
      reducerPerFlush: durationMetric(reducerFlushDurations),
      chunksPerFlush: countMetric(chunksPerFlush),
      bytesPerFlush: bytesMetric(bytesPerFlush),
      maxContiguousRunPerFlush: countMetric(maxRuns),
      flushCount: countMetric(samples.map((sample) => sample.flushCount)),
      clientChunkCount: countMetric(samples.map((sample) => sample.clientChunkCount)),
      reactCommits: countMetric(samples.map((sample) => sample.reactCommits)),
      reactDuration: durationMetric(samples.map((sample) => sample.reactDurationMs)),
      longTaskCount: countMetric(samples.map((sample) => sample.longTaskCount)),
      longTaskDuration: durationMetric(samples.map((sample) => sample.longTaskDurationMs)),
      delayedFrameIntervals: countMetric(
        frameSummaries.map((summary) => summary.delayedFrameIntervals),
      ),
      estimatedDroppedFrames: countMetric(
        frameSummaries.map((summary) => summary.estimatedDroppedFrames),
      ),
      maxFrameGap: durationMetric(frameSummaries.map((summary) => summary.maxFrameGapMs)),
      feedbackDelay: durationMetric(samples.map((sample) => sample.feedbackDelayMs)),
      feedbackDelayMax: durationMetric(samples.map((sample) => sample.feedbackDelayMaxMs)),
      feedbackSamples: countMetric(samples.map((sample) => sample.feedbackSamples)),
      heapDelta: bytesMetric(samples.map((sample) => sample.heapDeltaBytes)),
      postGcHeap: bytesMetric(samples.map((sample) => sample.postGcHeapBytes)),
      markdownBytes: bytesMetric(samples.map((sample) => sample.markdownBytes)),
      markdownParseCalls: countMetric(samples.map((sample) => sample.markdownParseCalls)),
      markdownParseDuration: durationMetric(
        samples.map((sample) => sample.markdownParseDurationMs),
      ),
      highlightCalls: countMetric(samples.map((sample) => sample.highlightCalls)),
      highlightCacheHits: countMetric(samples.map((sample) => sample.highlightCacheHits)),
      highlightDuration: durationMetric(samples.map((sample) => sample.highlightDurationMs)),
      highlightedTokens: countMetric(samples.map((sample) => sample.highlightedTokens)),
      assistantDomNodes: countMetric(samples.map((sample) => sample.assistantDomNodes)),
      axNodes: countMetric(samples.map((sample) => sample.axNodes)),
      axNonIgnoredNodes: countMetric(samples.map((sample) => sample.axNonIgnoredNodes)),
    },
  };
}

async function measureStreamRun(input: {
  browser: Browser;
  workspace: SeededWorkspace;
  workload: MarkdownWorkload;
  messageBytes: number;
  run: number;
  markdownOracle: MarkdownTextOracle | null;
}): Promise<StreamRunSample> {
  const { browser, workspace, workload, messageBytes, run, markdownOracle } = input;
  const created = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: `Desktop ${workload} ${messageBytes} run ${run}`,
    modeId: "load-test",
    model: "ten-second-stream",
  });
  const context = await browser.newContext({ viewport: VIEWPORT });
  let cdp: CDPSession | null = null;
  try {
    await seedBenchmarkStorage(context);
    const page = await context.newPage();
    await page.route(/:(6767)\b/, (route) => route.abort());
    await page.routeWebSocket(/:(6767)\b/, async (ws) => {
      await ws.close({ code: 1008, reason: "Desktop stream benchmark blocks production daemon." });
    });
    cdp = await context.newCDPSession(page);
    await cdp.send("HeapProfiler.enable");

    await openEmptyAgent(page, workspace, created.id);
    await cdp.send("HeapProfiler.collectGarbage");
    const heapBefore = await readHeap(page);
    await armStreamProbe(page);
    const prompt = isMarkdownBenchmark
      ? `emit ${messageBytes} byte markdown benchmark ${workload} in ${CHUNK_BYTES} byte chunks every 1 ms`
      : `emit ${messageBytes} byte coalesced assistant stream in ${CHUNK_BYTES} byte chunks every 1 ms`;
    await workspace.client.sendAgentMessage(created.id, prompt);
    const result = await workspace.client.waitForFinish(created.id, 60_000);
    if (result.status !== "idle") {
      throw new Error(`stream benchmark agent ${created.id} finished as ${result.status}`);
    }
    await waitForAssistantBytes(page, messageBytes);
    const sample = await finishStreamProbe(page, {
      expectedBytes: messageBytes,
      heapBefore,
      verifyPlainText: !isMarkdownBenchmark,
      markdownOracle,
    });
    const ax = await readAxNodeCounts(cdp);
    await cdp.send("HeapProfiler.collectGarbage");
    const postGcHeapBytes = await readHeap(page);
    const expandedRenderedTextHash = await expandLongAssistantMessageAndReadHash(
      page,
      sample.renderedTextHash,
    );
    await workspace.client.archiveAgent(created.id);
    await page.getByTestId(`workspace-tab-agent_${created.id}`).waitFor({
      state: "detached",
      timeout: 30_000,
    });
    return {
      ...sample,
      ...ax,
      postGcHeapBytes,
      expandedRenderedTextHash,
    };
  } finally {
    await cdp?.detach();
    await context.close();
  }
}

test("benchmarks live assistant streaming through reducer, React, and Markdown", async ({
  browser,
}) => {
  test.setTimeout(15 * 60_000);
  let workspace: SeededWorkspace | null = null;
  try {
    workspace = await seedWorkspace({ repoPrefix: "desktop-streaming-benchmark-" });

    const cases: BenchmarkCaseResult[] = [];
    for (const benchmarkCase of STREAM_CASES) {
      const { workload, messageBytes } = benchmarkCase;
      const markdownOracle = isMarkdownBenchmark
        ? buildMarkdownTextOracle(workload, messageBytes)
        : null;
      const samples: StreamRunSample[] = [];
      for (let run = 0; run < MEASURED_RUNS; run += 1) {
        samples.push(
          await measureStreamRun({
            browser,
            workspace,
            workload,
            messageBytes,
            run,
            markdownOracle,
          }),
        );
      }
      cases.push(buildCase({ workload, messageBytes, samples, markdownOracle }));
    }

    const result = {
      schemaVersion: 1,
      taskId: isMarkdownBenchmark ? "desktop-markdown" : "desktop-streaming",
      generatedAt: new Date().toISOString(),
      metadata: {
        runtime: "chromium-electron-overlay",
        measuredRuns: MEASURED_RUNS,
        chunkBytes: CHUNK_BYTES,
        feedbackTargetDelayMs: FEEDBACK_TARGET_DELAY_MS,
        feedbackSampleIntervalMs: FEEDBACK_SAMPLE_INTERVAL_MS,
        rendererState: "fresh-context-per-run",
        cacheState: "cold",
        assumedFrameIntervalMs: BENCHMARK_FRAME_INTERVAL_MS,
        viewportWidth: VIEWPORT.width,
        viewportHeight: VIEWPORT.height,
        benchmarkRelease: isMarkdownBenchmark ? "desktop_markdown_rendering@v5" : null,
        scorerVersion: isMarkdownBenchmark ? "desktop_markdown_metrics_v5" : null,
        correctnessOracle: isMarkdownBenchmark ? MARKDOWN_ORACLE_RELEASE : null,
      },
      cases,
    } satisfies BenchmarkTaskResult;
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    const outputPath = process.env.PASEO_BENCHMARK_OUTPUT;
    if (outputPath) await writeFile(outputPath, serialized);
    if (process.env.PASEO_BENCHMARK_QUIET !== "1") process.stdout.write(serialized);
  } finally {
    await workspace?.cleanup();
  }
});
