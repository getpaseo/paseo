import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";

const baseUrl = process.env.PASEO_PROFILE_APP_URL ?? "http://localhost:19010";
const digits = parseDigits(process.env.PASEO_PROFILE_WORKSPACE_DIGITS ?? "1234567");
const lruSize = Number(process.env.PASEO_PROFILE_WORKSPACE_LRU_SIZE ?? 3);
const retainedRepeatCount = Number(process.env.PASEO_PROFILE_RETAINED_REPEATS ?? 1);
const warmQuietMs = Number(process.env.PASEO_PROFILE_WARM_QUIET_MS ?? 300);
const finalWaitMs = Number(process.env.PASEO_PROFILE_FINAL_WAIT_MS ?? 1_000);
const headless = process.env.PASEO_PROFILE_HEADLESS !== "0";
const dumpCommits = process.env.PASEO_PROFILE_DUMP_COMMITS === "1";
const cpuProfilePath = process.env.PASEO_PROFILE_CPU_PATH;
const tracePath = process.env.PASEO_PROFILE_TRACE_PATH;
const traceInvalidations = process.env.PASEO_PROFILE_TRACE_INVALIDATIONS === "1";
const traceFocus = process.env.PASEO_PROFILE_TRACE_FOCUS === "1";

function parseDigits(value) {
  const parsed = [...value].filter((digit) => /^[1-9]$/.test(digit));
  if (parsed.length === 0 || new Set(parsed).size !== parsed.length) {
    throw new Error("PASEO_PROFILE_WORKSPACE_DIGITS must contain unique digits from 1 through 9");
  }
  return parsed;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

async function installBenchmarkShortcutOverride(page) {
  await page.addInitScript(
    ({ profileFocus }) => {
      localStorage.setItem(
        "@paseo:keyboard-shortcut-overrides",
        JSON.stringify({ "workspace-navigate-index-alt-digit-web": "Cmd+Digit" }),
      );

      const preserveRenderProfile = (original) => {
        return function (state, unused, url) {
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
      };
      history.pushState = preserveRenderProfile(history.pushState);
      history.replaceState = preserveRenderProfile(history.replaceState);

      if (profileFocus) {
        const originalFocus = HTMLElement.prototype.focus;
        HTMLElement.prototype.focus = function (...args) {
          const start = performance.now();
          const activeBefore = document.activeElement;
          const stack = new Error().stack;
          const ancestorTestIds = [];
          let workspaceElement = null;
          for (let element = this.parentElement; element; element = element.parentElement) {
            const testId = element.getAttribute("data-testid");
            if (testId) ancestorTestIds.push(testId);
            if (testId?.startsWith("workspace-deck-entry-")) {
              workspaceElement = element;
            }
          }
          const workspaceDisplayBefore = workspaceElement
            ? getComputedStyle(workspaceElement).display
            : null;
          const result = Reflect.apply(originalFocus, this, args);
          globalThis.__PASEO_FOCUS_PROFILE__ ??= [];
          globalThis.__PASEO_FOCUS_PROFILE__.push({
            time: start,
            duration: performance.now() - start,
            tagName: this.tagName,
            testId: this.getAttribute("data-testid"),
            ancestorTestIds,
            workspaceDisplayBefore,
            workspaceDisplayAfter: workspaceElement
              ? getComputedStyle(workspaceElement).display
              : null,
            pathname: location.pathname,
            deckDisplays: [
              ...document.querySelectorAll('[data-testid^="workspace-deck-entry-"]'),
            ].map((element) => ({
              testId: element.getAttribute("data-testid"),
              display: getComputedStyle(element).display,
            })),
            placeholder: this.getAttribute("placeholder"),
            ariaLabel: this.getAttribute("aria-label"),
            wasFocused: activeBefore === this,
            becameFocused: document.activeElement === this,
            stack,
          });
          return result;
        };
      }
    },
    { profileFocus: traceFocus },
  );
}

async function waitForProfilerIdle(page) {
  let previousCount = -1;
  let unchangedSince = Date.now();
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const count = await page.evaluate(() => globalThis.__PASEO_RENDER_PROFILE__?.length ?? 0);
    if (count !== previousCount) {
      previousCount = count;
      unchangedSince = Date.now();
    } else if (Date.now() - unchangedSince >= warmQuietMs) {
      return;
    }
    await page.waitForTimeout(50);
  }
  throw new Error("React profiler did not become idle during workspace warm-up");
}

async function pressWorkspaceShortcut(page, digit, previousDeckEntry) {
  await page.keyboard.down("Meta");
  await page.keyboard.press(digit);
  await page.keyboard.up("Meta");
  await page.waitForFunction(
    (previous) => {
      const active = [...document.querySelectorAll('[data-testid^="workspace-deck-entry-"]')].find(
        (entry) => getComputedStyle(entry).display !== "none",
      );
      const activeId = active?.getAttribute("data-testid");
      return Boolean(activeId && activeId !== previous);
    },
    previousDeckEntry,
    { timeout: 15_000 },
  );
  await waitForProfilerIdle(page);
  return page.evaluate(
    () =>
      [...document.querySelectorAll('[data-testid^="workspace-deck-entry-"]')]
        .find((entry) => getComputedStyle(entry).display !== "none")
        ?.getAttribute("data-testid") ?? null,
  );
}

async function warmWorkspaces(page, warmDigits, targets) {
  let activeEntry = await page.evaluate(
    () =>
      [...document.querySelectorAll('[data-testid^="workspace-deck-entry-"]')]
        .find((entry) => getComputedStyle(entry).display !== "none")
        ?.getAttribute("data-testid") ?? null,
  );
  for (const digit of warmDigits) {
    activeEntry = await pressWorkspaceShortcut(page, digit, activeEntry);
    if (!activeEntry) {
      throw new Error(`Cmd+${digit} did not activate a workspace`);
    }
    const previousTarget = targets.get(digit);
    if (previousTarget && previousTarget !== activeEntry) {
      throw new Error(`Cmd+${digit} changed targets during the benchmark`);
    }
    targets.set(digit, activeEntry);
  }
}

async function beginBrowserMeasurements(page, scenarioName) {
  await page.evaluate((name) => {
    globalThis.__PASEO_RESET_RENDER_PROFILE__?.();
    globalThis.__PASEO_WORKSPACE_SWITCH_BENCHMARK_CLEANUP__?.();
    globalThis.__PASEO_FOCUS_PROFILE__ = [];

    const getDeckEntries = () =>
      [...document.querySelectorAll('[data-testid^="workspace-deck-entry-"]')]
        .map((entry) => entry.getAttribute("data-testid"))
        .filter(Boolean);
    const getActiveEntry = () =>
      [...document.querySelectorAll('[data-testid^="workspace-deck-entry-"]')]
        .find((entry) => getComputedStyle(entry).display !== "none")
        ?.getAttribute("data-testid") ?? null;
    const measurements = {
      keydowns: [],
      activations: [],
      initialActiveEntry: getActiveEntry(),
      initialDeckEntries: getDeckEntries(),
    };
    let lastActiveEntry = measurements.initialActiveEntry;
    let activationSequence = 0;
    let keydownSequence = 0;

    const markTrace = (label) => {
      performance.mark(label);
      console.timeStamp(label);
    };
    markTrace(`paseo:${name}:capture-start`);

    const recordActivation = (records) => {
      const activeEntry = records
        .map((record) => record.target.getAttribute?.("data-testid"))
        .find(
          (testId) => testId?.startsWith("workspace-deck-entry-") && testId !== lastActiveEntry,
        );
      if (!activeEntry) return;
      lastActiveEntry = activeEntry;
      markTrace(`paseo:${name}:activation:${activationSequence}:${activeEntry}`);
      activationSequence += 1;
      measurements.activations.push({ activeEntry, time: performance.now() });
    };
    const recordKeydown = (digit) => {
      markTrace(`paseo:${name}:keydown:${keydownSequence}:Cmd+${digit}`);
      keydownSequence += 1;
      measurements.keydowns.push({
        digit,
        time: performance.now(),
        activeEntry: lastActiveEntry,
        deckEntries: getDeckEntries(),
      });
    };
    const observer = new MutationObserver(recordActivation);
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    globalThis.__PASEO_WORKSPACE_SWITCH_BENCHMARK__ = measurements;
    globalThis.__PASEO_RECORD_WORKSPACE_SWITCH_KEYDOWN__ = recordKeydown;
    globalThis.__PASEO_WORKSPACE_SWITCH_BENCHMARK_CLEANUP__ = () => {
      observer.disconnect();
    };
  }, scenarioName);
}

function groupCommits(samples) {
  const commits = new Map();
  for (const sample of samples) {
    const commit = commits.get(sample.commitTime) ?? {
      commitTime: sample.commitTime,
      rootActualDuration: null,
      rootPhase: null,
      components: [],
    };
    if (sample.id === "WorkspaceDeck") {
      commit.rootActualDuration = sample.actualDuration;
      commit.rootPhase = sample.phase;
    }
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

function buildScenarioReport(name, scenarioDigits, targets, measurements, samples) {
  const allCommits = groupCommits(samples);
  const firstKeydownTime = measurements.keydowns[0]?.time ?? null;
  const lastActivationTime = Math.max(
    firstKeydownTime ?? 0,
    ...measurements.activations.map((activation) => activation.time),
  );
  const captureWindowEnd = lastActivationTime + warmQuietMs;
  const commits = allCommits.filter(
    (commit) =>
      firstKeydownTime !== null &&
      commit.commitTime >= firstKeydownTime &&
      commit.commitTime <= captureWindowEnd,
  );
  const switches = measurements.keydowns.map((keydown, index) => {
    const target = targets.get(keydown.digit) ?? null;
    const activation = measurements.activations.find(
      (candidate) => candidate.activeEntry === target && candidate.time >= keydown.time,
    );
    const nextKeydownTime = measurements.keydowns[index + 1]?.time;
    const attributionEnd = nextKeydownTime ?? (activation?.time ?? keydown.time) + warmQuietMs;
    const attributedCommits = commits.filter(
      (commit) => commit.commitTime >= keydown.time && commit.commitTime < attributionEnd,
    );
    return {
      shortcut: `Cmd+${keydown.digit}`,
      target,
      retainedAtKeydown: target ? keydown.deckEntries.includes(target) : false,
      keydownTime: round(keydown.time),
      activationTime: activation ? round(activation.time) : null,
      activationLatency: activation ? round(activation.time - keydown.time) : null,
      commits: attributedCommits.length,
      workspaceMounts: attributedCommits.reduce(
        (total, commit) =>
          total +
          commit.components.filter(
            (component) => component.id === "WorkspaceScreenContent" && component.phase === "mount",
          ).length,
        0,
      ),
      rootActualDuration: round(
        attributedCommits.reduce((total, commit) => total + (commit.rootActualDuration ?? 0), 0),
      ),
    };
  });

  return {
    name,
    shortcuts: scenarioDigits.map((digit) => `Cmd+${digit}`),
    initialDeckEntries: measurements.initialDeckEntries,
    burstDuration: firstKeydownTime === null ? null : round(lastActivationTime - firstKeydownTime),
    commitCount: commits.length,
    rootActualDuration: round(
      commits.reduce((total, commit) => total + (commit.rootActualDuration ?? 0), 0),
    ),
    switches,
    commits: commits.map((commit) => ({
      commitTime: commit.commitTime,
      sinceBurstStart:
        firstKeydownTime === null ? null : round(commit.commitTime - firstKeydownTime),
      rootPhase: commit.rootPhase,
      rootActualDuration: commit.rootActualDuration,
      components: dumpCommits ? commit.components : undefined,
    })),
  };
}

async function runScenario(page, name, scenarioDigits, targets) {
  await beginBrowserMeasurements(page, name);
  await page.keyboard.down("Meta");
  for (const digit of scenarioDigits) {
    await page.evaluate((nextDigit) => {
      globalThis.__PASEO_RECORD_WORKSPACE_SWITCH_KEYDOWN__?.(nextDigit);
    }, digit);
    await page.keyboard.press(digit);
  }
  await page.keyboard.up("Meta");

  const finalTarget = targets.get(scenarioDigits.at(-1));
  await page.waitForFunction(
    (expected) =>
      [...document.querySelectorAll('[data-testid^="workspace-deck-entry-"]')]
        .find((entry) => getComputedStyle(entry).display !== "none")
        ?.getAttribute("data-testid") === expected,
    finalTarget,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(finalWaitMs);
  await waitForProfilerIdle(page);
  await page.evaluate((scenarioName) => {
    const label = `paseo:${scenarioName}:capture-end`;
    performance.mark(label);
    console.timeStamp(label);
  }, name);

  const result = await page.evaluate(() => ({
    measurements: globalThis.__PASEO_WORKSPACE_SWITCH_BENCHMARK__,
    samples: globalThis.__PASEO_RENDER_PROFILE__ ?? [],
    reasons: globalThis.__PASEO_RENDER_PROFILE_REASONS__ ?? {},
    focusCalls: globalThis.__PASEO_FOCUS_PROFILE__ ?? [],
  }));
  await page.evaluate(() => globalThis.__PASEO_WORKSPACE_SWITCH_BENCHMARK_CLEANUP__?.());
  return {
    ...buildScenarioReport(name, scenarioDigits, targets, result.measurements, result.samples),
    reasons: result.reasons,
    focusCalls: result.focusCalls,
  };
}

async function captureCpuProfile(page, run) {
  const session = await page.context().newCDPSession(page);
  await session.send("Profiler.enable");
  await session.send("Profiler.setSamplingInterval", { interval: 100 });
  await session.send("Profiler.start");
  try {
    await run();
  } finally {
    const { profile } = await session.send("Profiler.stop");
    await session.send("Profiler.disable");
    await writeFile(cpuProfilePath, JSON.stringify(profile));
  }
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
  const tracingComplete = new Promise((resolve) => {
    session.once("Tracing.tracingComplete", resolve);
  });
  const categories = [
    "-*",
    "toplevel",
    "devtools.timeline",
    "blink.user_timing",
    "latencyInfo",
    "disabled-by-default-devtools.timeline",
    "disabled-by-default-devtools.timeline.frame",
    "disabled-by-default-devtools.screenshot",
    "disabled-by-default-v8.cpu_profiler",
    "disabled-by-default-v8.cpu_profiler.hires",
  ];
  if (traceInvalidations) {
    categories.push("disabled-by-default-devtools.timeline.invalidationTracking");
  }
  await session.send("Tracing.start", {
    categories: categories.join(","),
    options: "sampling-frequency=10000",
    transferMode: "ReturnAsStream",
  });
  let result;
  try {
    result = await run();
  } finally {
    await session.send("Tracing.end");
    const completed = await tracingComplete;
    const trace = await readCdpStream(session, completed.stream);
    await writeFile(tracePath, trace);
  }
  return result;
}

async function main() {
  const browser = await chromium.launch({ headless });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const targets = new Map();

  try {
    await installBenchmarkShortcutOverride(page);
    await page.goto(`${baseUrl}/?renderProfile=1`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid^="sidebar-workspace-row-"]').first().waitFor({
      timeout: 60_000,
    });

    await warmWorkspaces(page, digits, targets);
    const fullBurst = await runScenario(page, "seven-workspace-burst", digits, targets);

    const retainedDigits = digits.slice(0, Math.min(lruSize, digits.length));
    await warmWorkspaces(page, retainedDigits, targets);
    const retainedBurstDigits = Array.from(
      { length: retainedRepeatCount },
      () => retainedDigits,
    ).flat();
    const retainedLru = await runScenario(page, "retained-lru", retainedBurstDigits, targets);

    if (cpuProfilePath) {
      await warmWorkspaces(page, retainedDigits, targets);
      await captureCpuProfile(page, () =>
        runScenario(page, "retained-lru-cpu", retainedBurstDigits, targets),
      );
    }

    let traceReport = null;
    if (tracePath) {
      await warmWorkspaces(page, retainedDigits, targets);
      traceReport = await captureDevToolsTrace(page, () =>
        runScenario(page, "retained-lru-trace", retainedBurstDigits, targets),
      );
    }

    console.log(
      JSON.stringify(
        {
          appUrl: baseUrl,
          warmQuietMs,
          lruSize,
          retainedRepeatCount,
          dumpCommits,
          cpuProfilePath: cpuProfilePath ?? null,
          tracePath: tracePath ?? null,
          traceInvalidations,
          traceFocus,
          traceReport,
          targets: Object.fromEntries(targets),
          scenarios: [retainedLru, fullBurst],
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
