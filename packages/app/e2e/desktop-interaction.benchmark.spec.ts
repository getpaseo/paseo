import { writeFile } from "node:fs/promises";
import type { Browser, BrowserContext, CDPSession, Page } from "@playwright/test";
import { buildCreateAgentPreferences, buildSeededHost } from "./support/helpers/daemon-registry";
import { getE2EDaemonPort } from "./support/helpers/daemon-port";
import { buildAgentRoute } from "./support/helpers/mock-agent";
import { getServerId } from "./support/helpers/server-id";
import { seedWorkspace, type SeededWorkspace } from "./support/helpers/seed-client";
import { scrollTimelineUntilOlderHistoryIsReachable } from "./support/helpers/timeline-pagination";
import { buildHostWorkspaceOpenRoute } from "../src/utils/host-routes";
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

const HISTORY_TURN_COUNTS = [25, 50, 88] as const;
const HEAVY_TAB_COUNTS = [1, 4, 8] as const;
const AGENTS_PER_HISTORY_SIZE = Math.max(...HEAVY_TAB_COUNTS);
const MEASURED_SWITCHES = 12;
const ASSISTANT_CHUNKS_PER_TURN = 32;
const SWITCH_TIMEOUT_MS = 20_000;
const VIEWPORT = { width: 1440, height: 900 };
const PRODUCT_DEFAULT_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD = 100;
const PRODUCT_DEFAULT_WEB_MOUNTED_RECENT_STREAM_ITEMS = 50;

interface SeededAgent {
  id: string;
  title: string;
  oldestPrompt: string;
  latestPrompt: string;
}

interface SeededHistoryGroup {
  historyItems: number;
  agents: SeededAgent[];
}

interface SwitchSample {
  selectedMs: number;
  titleReadyMs: number;
  bodyConsistentMs: number;
  titleBodyMismatchMs: number;
  reactCommits: number;
  reactDurationMs: number;
  longTaskCount: number;
  longTaskDurationMs: number;
  frameGapsMs: number[];
  heapDeltaBytes: number;
}

interface FootprintSnapshot {
  domNodes: number;
  activeTimelineDomNodes: number;
  inactiveTimelineDomNodes: number;
  activeTimelineCount: number;
  inactiveTimelineCount: number;
  axNodes: number;
  axNonIgnoredNodes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  heapUsedBeforeGcBytes: number;
}

interface BrowserMemory {
  usedJSHeapSize?: number;
  totalJSHeapSize?: number;
}

interface WindowWithBenchmarkState extends Window {
  __PASEO_RENDER_PROFILE__?: Array<{
    actualDuration: number;
    commitTime: number;
  }>;
  __PASEO_RESET_RENDER_PROFILE__?: () => void;
  __PASEO_DESKTOP_SWITCH_RESULT__?: Promise<Omit<SwitchSample, "heapDeltaBytes">>;
  __PASEO_E2E_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD?: number;
  __PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS?: number;
  __PASEO_E2E_RETAIN_INACTIVE_AGENT_TIMELINES?: boolean;
}

interface WebVirtualizationPolicy {
  threshold: number;
  mountedRecentItems: number;
  retainInactiveAgentTimelines: boolean;
}

function readPositiveIntegerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received ${raw}`);
  }
  return parsed;
}

function readWebVirtualizationPolicy(): WebVirtualizationPolicy {
  const retainInactiveTimelineEnvironment =
    process.env.PASEO_BENCHMARK_RETAIN_INACTIVE_AGENT_TIMELINES;
  return {
    threshold: readPositiveIntegerEnvironment(
      "PASEO_BENCHMARK_WEB_VIRTUALIZATION_THRESHOLD",
      PRODUCT_DEFAULT_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD,
    ),
    mountedRecentItems: readPositiveIntegerEnvironment(
      "PASEO_BENCHMARK_WEB_MOUNTED_RECENT_ITEMS",
      PRODUCT_DEFAULT_WEB_MOUNTED_RECENT_STREAM_ITEMS,
    ),
    retainInactiveAgentTimelines: retainInactiveTimelineEnvironment !== "0",
  };
}

function promptForTurn(historyItems: number, agentIndex: number, turnIndex: number): string {
  return `desktop-perf-h${historyItems}-a${agentIndex}-turn-${turnIndex}: emit ${ASSISTANT_CHUNKS_PER_TURN} coalesced agent stream updates`;
}

async function createHistoryGroups(workspace: SeededWorkspace): Promise<SeededHistoryGroup[]> {
  const groups: SeededHistoryGroup[] = [];
  for (const turnCount of HISTORY_TURN_COUNTS) {
    const historyItems = turnCount * 2;
    const agents = await Promise.all(
      Array.from({ length: AGENTS_PER_HISTORY_SIZE }, async (_, agentIndex) => {
        const title = `Desktop perf H${historyItems} A${agentIndex}`;
        const created = await workspace.client.createAgent({
          provider: "mock",
          cwd: workspace.repoPath,
          workspaceId: workspace.workspaceId,
          title,
          modeId: "load-test",
          model: "ten-second-stream",
        });
        return { id: created.id, title, oldestPrompt: "", latestPrompt: "" };
      }),
    );

    for (let turnIndex = 0; turnIndex < turnCount; turnIndex += 1) {
      await Promise.all(
        agents.map(async (agent, agentIndex) => {
          const prompt = promptForTurn(historyItems, agentIndex, turnIndex);
          await workspace.client.sendAgentMessage(agent.id, prompt);
          const result = await workspace.client.waitForFinish(agent.id, 15_000);
          if (result.status !== "idle") {
            throw new Error(`agent ${agent.id} did not become idle after seeded turn ${turnIndex}`);
          }
          if (turnIndex === 0) {
            agent.oldestPrompt = prompt;
          }
          agent.latestPrompt = prompt;
        }),
      );
    }

    groups.push({ historyItems, agents });
  }
  return groups;
}

async function createBenchmarkContext(
  browser: Browser,
  webVirtualizationPolicy: WebVirtualizationPolicy,
): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const daemonPort = getE2EDaemonPort();
  const serverId = getServerId();
  const nowIso = new Date().toISOString();
  const daemon = buildSeededHost({
    serverId,
    endpoint: `127.0.0.1:${daemonPort}`,
    nowIso,
  });
  const preferences = buildCreateAgentPreferences();
  await context.addInitScript(
    ({ seededDaemon, seededPreferences, virtualizationPolicy }) => {
      localStorage.setItem("@paseo:e2e", "1");
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seededDaemon]));
      localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(seededPreferences));
      localStorage.removeItem("@paseo:settings");
      const benchmarkWindow = window as WindowWithBenchmarkState;
      benchmarkWindow.__PASEO_E2E_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD =
        virtualizationPolicy.threshold;
      benchmarkWindow.__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS =
        virtualizationPolicy.mountedRecentItems;
      benchmarkWindow.__PASEO_E2E_RETAIN_INACTIVE_AGENT_TIMELINES =
        virtualizationPolicy.retainInactiveAgentTimelines;
    },
    {
      seededDaemon: daemon,
      seededPreferences: preferences,
      virtualizationPolicy: webVirtualizationPolicy,
    },
  );
  return context;
}

function appendRenderProfile(route: string): string {
  return `${route}${route.includes("?") ? "&" : "?"}renderProfile=1`;
}

async function scrollTimelineToBottom(page: Page): Promise<void> {
  const scroll = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  await scroll.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("Agent chat scroll element is not an HTMLElement");
    }
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

async function openAgentTab(
  page: Page,
  workspaceId: string,
  agent: SeededAgent,
  loadFullHistory: boolean,
): Promise<void> {
  await page.goto(appendRenderProfile(buildAgentRoute(workspaceId, agent.id)));
  await page.waitForURL(
    (url) =>
      url.pathname.includes("/workspace/") &&
      !url.searchParams.has("open") &&
      url.searchParams.get("renderProfile") === "1",
    { timeout: 60_000 },
  );
  await page.getByTestId(`workspace-tab-agent_${agent.id}`).waitFor({ timeout: 60_000 });
  await page.getByText(agent.latestPrompt, { exact: true }).waitFor({
    state: "visible",
    timeout: 60_000,
  });
  if (loadFullHistory) {
    await scrollTimelineUntilOlderHistoryIsReachable(page, agent.oldestPrompt);
    await page.getByText(agent.oldestPrompt, { exact: true }).waitFor({
      state: "visible",
      timeout: 60_000,
    });
    await scrollTimelineToBottom(page);
    await page.getByText(agent.latestPrompt, { exact: true }).waitFor({
      state: "visible",
      timeout: 60_000,
    });
  }
}

async function openTerminalTab(page: Page, workspaceId: string, terminalId: string): Promise<void> {
  const route = buildHostWorkspaceOpenRoute(getServerId(), workspaceId, `terminal:${terminalId}`);
  await page.goto(appendRenderProfile(route));
  await page.waitForURL(
    (url) =>
      url.pathname.includes("/workspace/") &&
      !url.searchParams.has("open") &&
      url.searchParams.get("renderProfile") === "1",
    { timeout: 60_000 },
  );
  await page.getByTestId(`workspace-tab-terminal_${terminalId}`).waitFor({ timeout: 60_000 });
}

async function readHeap(page: Page): Promise<{ used: number; total: number }> {
  return page.evaluate(() => {
    const memory = (performance as Performance & { memory?: BrowserMemory }).memory;
    return {
      used: memory?.usedJSHeapSize ?? 0,
      total: memory?.totalJSHeapSize ?? 0,
    };
  });
}

async function clickWorkspaceTab(page: Page, testId: string): Promise<void> {
  const tab = page.getByTestId(testId);
  const bounds = await tab.boundingBox();
  if (!bounds) {
    throw new Error(`workspace tab ${testId} has no clickable bounds`);
  }
  // Click the leading icon/label edge. Narrow Desktop tabs can place the nested close button
  // over their geometric center, which would turn a benchmark switch into an archive action.
  await tab.click({ position: { x: Math.min(8, bounds.width / 4), y: bounds.height / 2 } });
}

async function armSwitchMeasurement(
  page: Page,
  input: {
    targetTestId: string;
    targetTitle: string;
    targetPrompt: string;
    previousPrompt: string;
  },
): Promise<void> {
  await page.evaluate(
    ({ targetTestId, targetTitle, targetPrompt, previousPrompt, timeoutMs }) => {
      const state = window as WindowWithBenchmarkState;
      const target = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
        (element) => element.dataset.testid === targetTestId,
      );
      if (!target) {
        throw new Error(`missing target tab ${targetTestId}`);
      }
      const targetElement = target;

      state.__PASEO_DESKTOP_SWITCH_RESULT__ = new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error(`timed out measuring switch to ${targetTitle}`));
        }, timeoutMs);
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

        let startedAt = 0;
        let selectedAt: number | null = null;
        let titleReadyAt: number | null = null;
        let bodyConsistentAt: number | null = null;
        let frameHandle = 0;
        let previousFrameAt = 0;
        const frameGaps: number[] = [];
        let renderProfileStart = 0;

        function cleanup() {
          window.clearTimeout(timeout);
          observer?.disconnect();
          if (frameHandle) window.cancelAnimationFrame(frameHandle);
          targetElement.removeEventListener("pointerdown", onPointerDown, true);
        }

        function findVisibleTimeline(): HTMLElement | null {
          for (const node of document.querySelectorAll<HTMLElement>(
            '[data-testid="agent-chat-scroll"]',
          )) {
            const rect = node.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && node.offsetParent !== null) {
              return node;
            }
          }
          return null;
        }

        function finish() {
          const now = performance.now();
          const samples = (state.__PASEO_RENDER_PROFILE__ ?? []).slice(renderProfileStart);
          const commitTimes = new Set(samples.map((sample) => sample.commitTime));
          const longTaskDurationMs = longTasks.reduce((sum, entry) => sum + entry.duration, 0);
          cleanup();
          resolve({
            selectedMs: (selectedAt ?? now) - startedAt,
            titleReadyMs: (titleReadyAt ?? now) - startedAt,
            bodyConsistentMs: (bodyConsistentAt ?? now) - startedAt,
            titleBodyMismatchMs:
              titleReadyAt === null || bodyConsistentAt === null
                ? 0
                : Math.max(0, bodyConsistentAt - titleReadyAt),
            reactCommits: commitTimes.size,
            reactDurationMs: samples.reduce((sum, sample) => sum + sample.actualDuration, 0),
            longTaskCount: longTasks.length,
            longTaskDurationMs,
            frameGapsMs: frameGaps,
          });
        }

        function inspect() {
          const now = performance.now();
          if (previousFrameAt > 0) frameGaps.push(now - previousFrameAt);
          previousFrameAt = now;
          if (selectedAt === null && targetElement.getAttribute("aria-selected") === "true") {
            selectedAt = now;
          }
          if (titleReadyAt === null && document.title === targetTitle) {
            titleReadyAt = now;
          }
          const activeText = findVisibleTimeline()?.textContent ?? "";
          if (
            bodyConsistentAt === null &&
            activeText.includes(targetPrompt) &&
            !activeText.includes(previousPrompt)
          ) {
            bodyConsistentAt = now;
          }
          if (selectedAt !== null && titleReadyAt !== null && bodyConsistentAt !== null) {
            frameHandle = window.requestAnimationFrame(() => finish());
            return;
          }
          frameHandle = window.requestAnimationFrame(() => inspect());
        }

        function onPointerDown() {
          startedAt = performance.now();
          previousFrameAt = startedAt;
          renderProfileStart = state.__PASEO_RENDER_PROFILE__?.length ?? 0;
          frameHandle = window.requestAnimationFrame(() => inspect());
        }

        targetElement.addEventListener("pointerdown", onPointerDown, true);
      });
    },
    { ...input, timeoutMs: SWITCH_TIMEOUT_MS },
  );
}

async function measureSwitch(
  page: Page,
  target: SeededAgent,
  previous: SeededAgent,
): Promise<SwitchSample> {
  const heapBefore = await readHeap(page);
  const targetTestId = `workspace-tab-agent_${target.id}`;
  await armSwitchMeasurement(page, {
    targetTestId,
    targetTitle: target.title,
    targetPrompt: target.latestPrompt,
    previousPrompt: previous.latestPrompt,
  });
  await clickWorkspaceTab(page, targetTestId);
  const measured = await page.evaluate(async () => {
    const state = window as WindowWithBenchmarkState;
    if (!state.__PASEO_DESKTOP_SWITCH_RESULT__) {
      throw new Error("switch measurement was not armed");
    }
    return state.__PASEO_DESKTOP_SWITCH_RESULT__;
  });
  const heapAfter = await readHeap(page);
  return {
    ...measured,
    heapDeltaBytes: heapAfter.used - heapBefore.used,
  };
}

async function readFootprint(page: Page, cdp: CDPSession): Promise<FootprintSnapshot> {
  const heapBeforeGc = await readHeap(page);
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  const dom = await page.evaluate(() => {
    const timelines = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="agent-chat-scroll"]'),
    );
    let activeTimelineDomNodes = 0;
    let inactiveTimelineDomNodes = 0;
    let activeTimelineCount = 0;
    let inactiveTimelineCount = 0;
    for (const timeline of timelines) {
      const nodes = timeline.querySelectorAll("*").length + 1;
      const rect = timeline.getBoundingClientRect();
      const isActive = rect.width > 0 && rect.height > 0 && timeline.offsetParent !== null;
      if (isActive) {
        activeTimelineCount += 1;
        activeTimelineDomNodes += nodes;
      } else {
        inactiveTimelineCount += 1;
        inactiveTimelineDomNodes += nodes;
      }
    }
    const memory = (performance as Performance & { memory?: BrowserMemory }).memory;
    return {
      domNodes: document.querySelectorAll("*").length,
      activeTimelineDomNodes,
      inactiveTimelineDomNodes,
      activeTimelineCount,
      inactiveTimelineCount,
      heapUsedBytes: memory?.usedJSHeapSize ?? 0,
      heapTotalBytes: memory?.totalJSHeapSize ?? 0,
    };
  });
  await cdp.send("Accessibility.enable");
  const axTree = (await cdp.send("Accessibility.getFullAXTree")) as {
    nodes?: Array<{ ignored?: boolean }>;
  };
  await cdp.send("Accessibility.disable");
  const axNodes = axTree.nodes ?? [];
  return {
    ...dom,
    axNodes: axNodes.length,
    axNonIgnoredNodes: axNodes.filter((node) => node.ignored !== true).length,
    heapUsedBeforeGcBytes: heapBeforeGc.used,
  };
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

function buildCaseResult(input: {
  historyItems: number;
  heavyTabs: number;
  samples: SwitchSample[];
  footprint: FootprintSnapshot;
  webVirtualizationPolicy: WebVirtualizationPolicy;
}): BenchmarkCaseResult {
  const { historyItems, heavyTabs, samples, footprint, webVirtualizationPolicy } = input;
  const frameSummaries = samples.map((sample) => summarizeFrameGaps(sample.frameGapsMs));
  return {
    id: `tabs-${heavyTabs}-history-${historyItems}`,
    dimensions: {
      heavyTabs,
      historyItems,
      assistantChunksPerTurn: ASSISTANT_CHUNKS_PER_TURN,
      measuredSwitches: samples.length,
      webVirtualizationThreshold: webVirtualizationPolicy.threshold,
      webMountedRecentItems: webVirtualizationPolicy.mountedRecentItems,
      retainInactiveAgentTimelines: webVirtualizationPolicy.retainInactiveAgentTimelines,
      fullStoredHistoryLoaded: true,
      assumedFrameIntervalMs: BENCHMARK_FRAME_INTERVAL_MS,
    },
    metrics: {
      selected: durationMetric(samples.map((sample) => sample.selectedMs)),
      titleReady: durationMetric(samples.map((sample) => sample.titleReadyMs)),
      bodyConsistent: durationMetric(samples.map((sample) => sample.bodyConsistentMs)),
      titleBodyMismatch: durationMetric(samples.map((sample) => sample.titleBodyMismatchMs)),
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
      heapDelta: bytesMetric(samples.map((sample) => sample.heapDeltaBytes)),
      footprint: {
        unit: "count",
        values: {
          domNodes: footprint.domNodes,
          activeTimelineDomNodes: footprint.activeTimelineDomNodes,
          inactiveTimelineDomNodes: footprint.inactiveTimelineDomNodes,
          activeTimelineCount: footprint.activeTimelineCount,
          inactiveTimelineCount: footprint.inactiveTimelineCount,
          axNodes: footprint.axNodes,
          axNonIgnoredNodes: footprint.axNonIgnoredNodes,
        },
      },
      heap: {
        unit: "bytes",
        values: {
          used: footprint.heapUsedBytes,
          total: footprint.heapTotalBytes,
          usedBeforeGc: footprint.heapUsedBeforeGcBytes,
          reclaimedByGc: Math.max(0, footprint.heapUsedBeforeGcBytes - footprint.heapUsedBytes),
        },
      },
    },
  };
}

async function measureCase(input: {
  browser: Browser;
  workspaceId: string;
  terminalId: string;
  group: SeededHistoryGroup;
  heavyTabs: number;
  webVirtualizationPolicy: WebVirtualizationPolicy;
}): Promise<BenchmarkCaseResult> {
  const context = await createBenchmarkContext(input.browser, input.webVirtualizationPolicy);
  const page = await context.newPage();
  await page.route(/:(6767)\b/, (route) => route.abort());
  await page.routeWebSocket(/:(6767)\b/, async (ws) => {
    await ws.close({ code: 1008, reason: "Desktop benchmark blocks the production daemon." });
  });
  const selectedAgents = input.group.agents.slice(0, input.heavyTabs);
  try {
    for (const agent of selectedAgents) {
      await openAgentTab(page, input.workspaceId, agent, input.group.historyItems > 100);
    }

    for (const agent of selectedAgents) {
      await clickWorkspaceTab(page, `workspace-tab-agent_${agent.id}`);
      await page.getByText(agent.latestPrompt, { exact: true }).waitFor({ state: "visible" });
    }
    await page.evaluate(() => {
      (window as WindowWithBenchmarkState).__PASEO_RESET_RENDER_PROFILE__?.();
    });

    const samples: SwitchSample[] = [];
    if (selectedAgents.length === 1) {
      // A single heavy tab is measured as a retained re-entry from a lightweight terminal tab.
      await openTerminalTab(page, input.workspaceId, input.terminalId);
      const terminalTabTestId = `workspace-tab-terminal_${input.terminalId}`;
      const target = selectedAgents[0];
      if (!target) throw new Error("missing single-tab benchmark agent");
      const terminalSource: SeededAgent = {
        ...target,
        oldestPrompt: "__desktop_performance_terminal_has_no_agent_prompt__",
        latestPrompt: "__desktop_performance_terminal_has_no_agent_prompt__",
      };
      for (let index = 0; index < MEASURED_SWITCHES; index += 1) {
        samples.push(await measureSwitch(page, target, terminalSource));
        if (index < MEASURED_SWITCHES - 1) {
          await clickWorkspaceTab(page, terminalTabTestId);
        }
      }
    } else {
      let previous = selectedAgents[selectedAgents.length - 1];
      if (!previous) throw new Error("missing previous benchmark agent");
      for (let index = 0; index < MEASURED_SWITCHES; index += 1) {
        const target = selectedAgents[index % selectedAgents.length];
        if (!target) throw new Error(`missing target benchmark agent at ${index}`);
        samples.push(await measureSwitch(page, target, previous));
        previous = target;
      }
    }

    const cdp = await context.newCDPSession(page);
    const footprint = await readFootprint(page, cdp);
    await cdp.detach();
    return buildCaseResult({
      historyItems: input.group.historyItems,
      heavyTabs: input.heavyTabs,
      samples,
      footprint,
      webVirtualizationPolicy: input.webVirtualizationPolicy,
    });
  } finally {
    await context.close();
  }
}

test("benchmarks Desktop interaction under retained heavy timelines", async ({ browser }) => {
  test.setTimeout(15 * 60_000);
  let workspace: SeededWorkspace | null = null;
  try {
    const webVirtualizationPolicy = readWebVirtualizationPolicy();
    workspace = await seedWorkspace({ repoPrefix: "desktop-interaction-benchmark-" });
    const groups = await createHistoryGroups(workspace);
    const terminalResult = await workspace.client.createTerminal(
      workspace.repoPath,
      "Desktop performance control",
      undefined,
      { workspaceId: workspace.workspaceId },
    );
    const terminalId = terminalResult.terminal?.id;
    if (!terminalId) {
      throw new Error(terminalResult.error ?? "failed to create benchmark control terminal");
    }
    const cases: BenchmarkCaseResult[] = [];
    for (const group of groups) {
      for (const heavyTabs of HEAVY_TAB_COUNTS) {
        cases.push(
          await measureCase({
            browser,
            workspaceId: workspace.workspaceId,
            terminalId,
            group,
            heavyTabs,
            webVirtualizationPolicy,
          }),
        );
      }
    }

    const result = {
      schemaVersion: 1,
      taskId: "desktop-interaction",
      generatedAt: new Date().toISOString(),
      metadata: {
        runtime: "chromium-electron-overlay",
        measuredSwitches: MEASURED_SWITCHES,
        assistantChunksPerTurn: ASSISTANT_CHUNKS_PER_TURN,
        viewportWidth: VIEWPORT.width,
        viewportHeight: VIEWPORT.height,
        webVirtualizationThreshold: webVirtualizationPolicy.threshold,
        webMountedRecentItems: webVirtualizationPolicy.mountedRecentItems,
        retainInactiveAgentTimelines: webVirtualizationPolicy.retainInactiveAgentTimelines,
        fullStoredHistoryLoaded: true,
      },
      cases,
    } satisfies BenchmarkTaskResult;
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    const outputPath = process.env.PASEO_BENCHMARK_OUTPUT;
    if (outputPath) await writeFile(outputPath, serialized);
    if (process.env.PASEO_BENCHMARK_QUIET !== "1") {
      process.stdout.write(serialized);
    }
  } finally {
    await workspace?.cleanup();
  }
});
