import { chromium } from "playwright";

const baseUrl = process.env.PASEO_PROFILE_APP_URL ?? "http://localhost:19010";
const digits = parseDigits(process.env.PASEO_PROFILE_WORKSPACE_DIGITS ?? "1234567");
const lruSize = Number(process.env.PASEO_PROFILE_WORKSPACE_LRU_SIZE ?? 3);
const warmQuietMs = Number(process.env.PASEO_PROFILE_WARM_QUIET_MS ?? 300);
const finalWaitMs = Number(process.env.PASEO_PROFILE_FINAL_WAIT_MS ?? 1_000);
const headless = process.env.PASEO_PROFILE_HEADLESS !== "0";
const dumpCommits = process.env.PASEO_PROFILE_DUMP_COMMITS === "1";

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
  await page.addInitScript(() => {
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
  });
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

async function beginBrowserMeasurements(page) {
  await page.evaluate(() => {
    globalThis.__PASEO_RESET_RENDER_PROFILE__?.();
    globalThis.__PASEO_WORKSPACE_SWITCH_BENCHMARK_CLEANUP__?.();

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

    const recordActivation = () => {
      const activeEntry = getActiveEntry();
      if (!activeEntry || activeEntry === lastActiveEntry) return;
      lastActiveEntry = activeEntry;
      measurements.activations.push({ activeEntry, time: performance.now() });
    };
    const recordKeydown = (digit) => {
      measurements.keydowns.push({
        digit,
        time: performance.now(),
        activeEntry: getActiveEntry(),
        deckEntries: getDeckEntries(),
      });
    };
    const observer = new MutationObserver(recordActivation);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["style"],
    });
    globalThis.__PASEO_WORKSPACE_SWITCH_BENCHMARK__ = measurements;
    globalThis.__PASEO_RECORD_WORKSPACE_SWITCH_KEYDOWN__ = recordKeydown;
    globalThis.__PASEO_WORKSPACE_SWITCH_BENCHMARK_CLEANUP__ = () => {
      observer.disconnect();
    };
  });
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
  await beginBrowserMeasurements(page);
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

  const result = await page.evaluate(() => ({
    measurements: globalThis.__PASEO_WORKSPACE_SWITCH_BENCHMARK__,
    samples: globalThis.__PASEO_RENDER_PROFILE__ ?? [],
    reasons: globalThis.__PASEO_RENDER_PROFILE_REASONS__ ?? {},
  }));
  await page.evaluate(() => globalThis.__PASEO_WORKSPACE_SWITCH_BENCHMARK_CLEANUP__?.());
  return {
    ...buildScenarioReport(name, scenarioDigits, targets, result.measurements, result.samples),
    reasons: result.reasons,
  };
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
    const retainedLru = await runScenario(page, "retained-lru", retainedDigits, targets);

    console.log(
      JSON.stringify(
        {
          appUrl: baseUrl,
          warmQuietMs,
          lruSize,
          dumpCommits,
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
