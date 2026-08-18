import { connect } from "node:net";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const appUrl = process.env.PASEO_PROFILE_APP_URL ?? "http://127.0.0.1:8081";
const daemonPort = Number(process.env.PASEO_PROFILE_DAEMON_PORT ?? 6768);
const workspaceCwd = process.env.PASEO_PROFILE_WORKSPACE_CWD ?? repoRoot;
const workspaceId = process.env.PASEO_PROFILE_WORKSPACE_ID ?? resolvePaseoWorkspaceId();
const serverId =
  process.env.PASEO_PROFILE_SERVER_ID ??
  (await readFile(resolve(repoRoot, ".dev/paseo-home/server-id"), "utf8")).trim();
const warmPresses = numberFromEnv("PASEO_PROFILE_WARM_PRESSES", 8);
const measuredPresses = numberFromEnv("PASEO_PROFILE_MEASURED_PRESSES", 20);
const burstPresses = numberFromEnv("PASEO_PROFILE_BURST_PRESSES", 20);
const burstCadenceMs = numberFromEnv("PASEO_PROFILE_BURST_CADENCE_MS", 50);
const idleBaselineMs = numberFromEnv("PASEO_PROFILE_IDLE_MS", 2_000);
const tracePath = process.env.PASEO_PROFILE_TRACE_PATH?.trim() || null;
const cpuProfilePath = process.env.PASEO_PROFILE_CPU_PATH?.trim() || null;
const dumpCommits = process.env.PASEO_PROFILE_DUMP_COMMITS === "1";

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

function resolvePaseoWorkspaceId() {
  const output = execFileSync("npm", ["run", "cli", "--", "workspace", "ls", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  const jsonStart = output.indexOf("[\n");
  if (jsonStart < 0) throw new Error("Could not parse `paseo workspace ls --json`");
  const workspaces = JSON.parse(output.slice(jsonStart));
  const candidates = workspaces.filter((workspace) => workspace.cwd === workspaceCwd);
  const workspace = candidates.find((candidate) => candidate.name === "Paseo") ?? candidates[0];
  if (!workspace?.workspaceId) {
    throw new Error(`No active workspace found for ${workspaceCwd}`);
  }
  return workspace.workspaceId;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]);
}

function summarizeDurations(values) {
  return {
    count: values.length,
    minMs: values.length > 0 ? round(Math.min(...values)) : null,
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length > 0 ? round(Math.max(...values)) : null,
  };
}

async function assertPortReachable(port) {
  await new Promise((resolveConnection, rejectConnection) => {
    const socket = connect({ host: "127.0.0.1", port });
    const timeout = setTimeout(() => {
      socket.destroy();
      rejectConnection(new Error(`Timed out connecting to daemon on 127.0.0.1:${port}`));
    }, 2_000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolveConnection();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      rejectConnection(error);
    });
  });
}

async function installMeasurementProbe(page) {
  await page.evaluate(() => {
    const readExplorerState = () => {
      const tab = document.querySelector('[data-testid="workspace-tab-working_diff"]');
      const group = tab?.closest('[data-testid^="split-group-child"]');
      const testId = group?.getAttribute("data-testid");
      if (testId === "split-group-child-hidden") return "hidden";
      if (testId === "split-group-child") return "visible";
      return "absent";
    };
    const state = {
      events: [],
      domMutations: 0,
      addedNodes: 0,
      removedNodes: 0,
      explorerMounts: 0,
      explorerUnmounts: 0,
      explorerMounted: readExplorerState() !== "absent",
    };
    const settleLatestEvent = () => {
      const event = state.events.findLast((candidate) => candidate.paintTime === null);
      if (!event) return;
      const after = readExplorerState();
      if (after === event.before) return;
      event.after = after;
      event.mutationTime ??= performance.now();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          event.paintTime ??= performance.now();
        });
      });
    };
    const observer = new MutationObserver((records) => {
      state.domMutations += records.length;
      for (const record of records) {
        state.addedNodes += record.addedNodes.length;
        state.removedNodes += record.removedNodes.length;
      }
      const explorerMounted = readExplorerState() !== "absent";
      if (!state.explorerMounted && explorerMounted) state.explorerMounts += 1;
      if (state.explorerMounted && !explorerMounted) state.explorerUnmounts += 1;
      state.explorerMounted = explorerMounted;
      settleLatestEvent();
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-testid", "style"],
      childList: true,
      subtree: true,
    });
    const onKeyDown = (event) => {
      if (!event.metaKey || event.code !== "KeyE") return;
      const sequence = state.events.length;
      performance.mark(`paseo:explorer-toggle:keydown:${sequence}`);
      console.timeStamp(`paseo:explorer-toggle:keydown:${sequence}`);
      state.events.push({
        sequence,
        inputTime: event.timeStamp,
        before: globalThis.__PASEO_EXPLORER_TOGGLE_PENDING_BEFORE__ ?? readExplorerState(),
        after: null,
        mutationTime: null,
        paintTime: null,
      });
      globalThis.__PASEO_EXPLORER_TOGGLE_PENDING_BEFORE__ = undefined;
    };
    addEventListener("keydown", onKeyDown, true);
    globalThis.__PASEO_EXPLORER_TOGGLE_PROFILE__ = state;
    globalThis.__PASEO_EXPLORER_TOGGLE_STATE__ = readExplorerState;
    globalThis.__PASEO_EXPLORER_TOGGLE_RESET__ = () => {
      state.events.length = 0;
      state.domMutations = 0;
      state.addedNodes = 0;
      state.removedNodes = 0;
      state.explorerMounts = 0;
      state.explorerUnmounts = 0;
      state.explorerMounted = readExplorerState() !== "absent";
      globalThis.__PASEO_RESET_RENDER_PROFILE__?.();
    };
  });
}

async function explorerState(page) {
  return page.evaluate(() => globalThis.__PASEO_EXPLORER_TOGGLE_STATE__?.() ?? "absent");
}

async function waitForProfilerIdle(page, quietMs = 500) {
  let previousCount = -1;
  let unchangedSince = Date.now();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const count = await page.evaluate(() => globalThis.__PASEO_RENDER_PROFILE__?.length ?? 0);
    if (count !== previousCount) {
      previousCount = count;
      unchangedSince = Date.now();
    } else if (Date.now() - unchangedSince >= quietMs) {
      return;
    }
    await page.waitForTimeout(50);
  }
  throw new Error("React profiler did not become idle");
}

async function pressAndWaitForPaint(page) {
  const eventIndex = await page.evaluate(
    () => globalThis.__PASEO_EXPLORER_TOGGLE_PROFILE__?.events.length ?? 0,
  );
  const before = await explorerState(page);
  await page.evaluate((state) => {
    globalThis.__PASEO_EXPLORER_TOGGLE_PENDING_BEFORE__ = state;
  }, before);
  await page.keyboard.press("Meta+e");
  try {
    await page.waitForFunction(
      (index) => {
        const event = globalThis.__PASEO_EXPLORER_TOGGLE_PROFILE__?.events[index];
        return event !== undefined && typeof event.paintTime === "number";
      },
      eventIndex,
      { timeout: 15_000 },
    );
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      state: globalThis.__PASEO_EXPLORER_TOGGLE_STATE__?.(),
      measurements: globalThis.__PASEO_EXPLORER_TOGGLE_PROFILE__,
    }));
    throw new Error(`Cmd+E did not paint: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
}

async function pressBurst(page, count, cadenceMs) {
  const initialState = await explorerState(page);
  let expectedBefore = initialState;
  await page.keyboard.down("Meta");
  try {
    for (let index = 0; index < count; index += 1) {
      await page.evaluate((state) => {
        globalThis.__PASEO_EXPLORER_TOGGLE_PENDING_BEFORE__ = state;
      }, expectedBefore);
      await page.keyboard.press("e");
      expectedBefore = expectedBefore === "visible" ? "hidden" : "visible";
      if (index + 1 < count) await page.waitForTimeout(cadenceMs);
    }
  } finally {
    await page.keyboard.up("Meta");
  }
  await page.waitForFunction(
    (expectedCount) => {
      const events = globalThis.__PASEO_EXPLORER_TOGGLE_PROFILE__?.events ?? [];
      return (
        events.length === expectedCount &&
        events.every((event) => typeof event.paintTime === "number")
      );
    },
    count,
    { timeout: 15_000 },
  );
  const finalState = await explorerState(page);
  let expectedFinalState = initialState;
  if (count % 2 !== 0) {
    expectedFinalState = initialState === "visible" ? "hidden" : "visible";
  }
  if (finalState !== expectedFinalState) {
    throw new Error(
      `Cmd+E burst lost an input: expected ${expectedFinalState}, observed ${finalState}`,
    );
  }
}

function groupCommits(samples) {
  const commits = new Map();
  for (const sample of samples) {
    const commit = commits.get(sample.commitTime) ?? {
      commitTime: sample.commitTime,
      rootActualDuration: null,
      components: [],
    };
    if (sample.id === "WorkspaceDeck") commit.rootActualDuration = sample.actualDuration;
    commit.components.push({
      id: sample.id,
      phase: sample.phase,
      actualDuration: round(sample.actualDuration),
      baseDuration: round(sample.baseDuration),
    });
    commits.set(sample.commitTime, commit);
  }
  return [...commits.values()]
    .sort((left, right) => left.commitTime - right.commitTime)
    .map((commit) => {
      commit.commitTime = round(commit.commitTime);
      commit.rootActualDuration =
        commit.rootActualDuration === null ? null : round(commit.rootActualDuration);
      commit.components.sort((left, right) => right.actualDuration - left.actualDuration);
      return commit;
    });
}

function summarizeComponents(samples) {
  const components = new Map();
  for (const sample of samples) {
    const current = components.get(sample.id) ?? {
      renders: 0,
      totalActualDuration: 0,
      durations: [],
    };
    current.renders += 1;
    current.totalActualDuration += sample.actualDuration;
    current.durations.push(sample.actualDuration);
    components.set(sample.id, current);
  }
  return [...components.entries()]
    .map(([id, value]) => ({
      id,
      renders: value.renders,
      totalActualDurationMs: round(value.totalActualDuration),
      medianActualDurationMs: percentile(value.durations, 0.5),
      p95ActualDurationMs: percentile(value.durations, 0.95),
    }))
    .sort((left, right) => right.totalActualDurationMs - left.totalActualDurationMs);
}

async function readScenario(page, name) {
  const result = await page.evaluate(() => ({
    measurements: globalThis.__PASEO_EXPLORER_TOGGLE_PROFILE__,
    samples: globalThis.__PASEO_RENDER_PROFILE__ ?? [],
    reasons: globalThis.__PASEO_RENDER_PROFILE_REASONS__ ?? {},
  }));
  const events = result.measurements.events;
  const inputToMutation = events.map((event) => event.mutationTime - event.inputTime);
  const inputToPaint = events.map((event) => event.paintTime - event.inputTime);
  const commits = groupCommits(result.samples);
  return {
    name,
    inputCount: events.length,
    transitions: events.map((event) => `${event.before}->${event.after}`),
    inputToMutation: summarizeDurations(inputToMutation),
    inputToPaint: summarizeDurations(inputToPaint),
    react: {
      commitCount: commits.length,
      rootCommitDuration: summarizeDurations(
        commits.flatMap((commit) =>
          commit.rootActualDuration === null ? [] : [commit.rootActualDuration],
        ),
      ),
      components: summarizeComponents(result.samples),
      reasons: result.reasons,
      commits: dumpCommits ? commits : undefined,
    },
    dom: {
      mutationRecords: result.measurements.domMutations,
      addedNodes: result.measurements.addedNodes,
      removedNodes: result.measurements.removedNodes,
      explorerMounts: result.measurements.explorerMounts,
      explorerUnmounts: result.measurements.explorerUnmounts,
    },
  };
}

async function resetMeasurements(page) {
  await page.evaluate(() => globalThis.__PASEO_EXPLORER_TOGGLE_RESET__?.());
}

async function runSettledScenario(page, name, count) {
  await resetMeasurements(page);
  for (let index = 0; index < count; index += 1) await pressAndWaitForPaint(page);
  return readScenario(page, name);
}

async function runIdleScenario(page) {
  await resetMeasurements(page);
  await page.waitForTimeout(idleBaselineMs);
  return readScenario(page, "idle-baseline");
}

async function runBurstScenario(page, name, count) {
  await resetMeasurements(page);
  await pressBurst(page, count, burstCadenceMs);
  return readScenario(page, name);
}

async function captureCpuProfile(page, run) {
  const session = await page.context().newCDPSession(page);
  await session.send("Profiler.enable");
  await session.send("Profiler.setSamplingInterval", { interval: 100 });
  await session.send("Profiler.start");
  try {
    return await run();
  } finally {
    const { profile } = await session.send("Profiler.stop");
    await session.send("Profiler.disable");
    await writeFile(cpuProfilePath, JSON.stringify(profile));
  }
}

async function collectMemory(session, page) {
  await session.send("HeapProfiler.collectGarbage");
  const [heap, performanceMetrics, explorerTabs] = await Promise.all([
    session.send("Runtime.getHeapUsage"),
    session.send("Performance.getMetrics"),
    page.locator('[data-testid="workspace-tab-working_diff"]').count(),
  ]);
  const metrics = Object.fromEntries(
    performanceMetrics.metrics
      .filter((metric) => ["JSHeapUsedSize", "JSHeapTotalSize", "Nodes"].includes(metric.name))
      .map((metric) => [metric.name, round(metric.value)]),
  );
  return {
    usedSize: heap.usedSize,
    totalSize: heap.totalSize,
    embedderHeapUsedSize: heap.embedderHeapUsedSize,
    backingStorageSize: heap.backingStorageSize,
    domNodes: metrics.Nodes ?? null,
    explorerTabs,
    metrics,
  };
}

async function readCdpStream(session, handle) {
  const chunks = [];
  while (true) {
    const result = await session.send("IO.read", { handle });
    chunks.push(
      result.base64Encoded ? Buffer.from(result.data, "base64") : Buffer.from(result.data),
    );
    if (result.eof) break;
  }
  await session.send("IO.close", { handle });
  return Buffer.concat(chunks);
}

async function captureDevToolsTrace(page, run) {
  const session = await page.context().newCDPSession(page);
  const tracingComplete = new Promise((resolveTrace) => {
    session.once("Tracing.tracingComplete", resolveTrace);
  });
  await session.send("Tracing.start", {
    categories: [
      "-*",
      "toplevel",
      "devtools.timeline",
      "blink.user_timing",
      "latencyInfo",
      "disabled-by-default-devtools.timeline",
      "disabled-by-default-devtools.timeline.frame",
      "disabled-by-default-v8.cpu_profiler",
      "disabled-by-default-v8.cpu_profiler.hires",
    ].join(","),
    options: "sampling-frequency=10000",
    transferMode: "ReturnAsStream",
  });
  let result;
  try {
    result = await run();
  } finally {
    await session.send("Tracing.end");
    const completed = await tracingComplete;
    await writeFile(tracePath, await readCdpStream(session, completed.stream));
  }
  return result;
}

async function main() {
  await assertPortReachable(daemonPort);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    await page.addInitScript(() => {
      const preserveRenderProfile = (original) =>
        function preserveProfileParam(state, unused, url) {
          if (url === undefined || url === null) {
            return Reflect.apply(original, this, [state, unused, url]);
          }
          const nextUrl = new URL(String(url), location.href);
          nextUrl.searchParams.set("renderProfile", "1");
          return Reflect.apply(original, this, [
            state,
            unused,
            `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
          ]);
        };
      history.pushState = preserveRenderProfile(history.pushState);
      history.replaceState = preserveRenderProfile(history.replaceState);
    });
    await page.goto(`${appUrl}/?renderProfile=1`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const workspaceRow = page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceId}`);
    await workspaceRow.waitFor({ timeout: 60_000 });
    await workspaceRow.click();
    await page.getByTestId("workspace-tabs-row").first().waitFor({ timeout: 60_000 });
    await waitForProfilerIdle(page);
    await installMeasurementProbe(page);

    if ((await explorerState(page)) === "absent") {
      await pressAndWaitForPaint(page);
      await waitForProfilerIdle(page);
    }
    for (let index = 0; index < warmPresses; index += 1) await pressAndWaitForPaint(page);

    const memorySession = await page.context().newCDPSession(page);
    await memorySession.send("Performance.enable");
    const memoryBefore = await collectMemory(memorySession, page);
    const idle = await runIdleScenario(page);
    const settled = await runSettledScenario(page, "retained-settled", measuredPresses);
    const burst = await runBurstScenario(page, "retained-burst", burstPresses);
    const memoryAfter = await collectMemory(memorySession, page);
    await memorySession.send("Performance.disable");

    let cpu = null;
    if (cpuProfilePath) {
      cpu = await captureCpuProfile(page, () =>
        runSettledScenario(page, "retained-settled-cpu", measuredPresses),
      );
    }
    let trace = null;
    if (tracePath) {
      trace = await captureDevToolsTrace(page, () =>
        runSettledScenario(page, "retained-settled-trace", measuredPresses),
      );
    }

    console.log(
      JSON.stringify(
        {
          appUrl,
          daemon: `127.0.0.1:${daemonPort}`,
          serverId,
          workspaceId,
          workspaceCwd,
          warmPresses,
          measuredPresses,
          burstPresses,
          burstCadenceMs,
          idleBaselineMs,
          cpuProfilePath,
          tracePath,
          memory: { before: memoryBefore, after: memoryAfter },
          scenarios: [idle, settled, burst],
          profileScenarios: { cpu, trace },
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

await main();
