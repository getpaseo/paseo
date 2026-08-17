import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";

const baseUrl = process.env.PASEO_PROFILE_APP_URL ?? "http://localhost:19010";
const cadenceMs = Number(process.env.PASEO_PROFILE_TYPING_CADENCE_MS ?? 16);
const scenario = process.env.PASEO_PROFILE_TYPING_SCENARIO ?? "continuous-text";
if (!["continuous-text", "height-growth"].includes(scenario)) {
  throw new Error(
    `Unknown PASEO_PROFILE_TYPING_SCENARIO: ${scenario}. Use continuous-text or height-growth.`,
  );
}
const sampleCount = Number(
  process.env.PASEO_PROFILE_TYPING_KEYS ?? (scenario === "height-growth" ? 24 : 300),
);
const repeatCount = Number(process.env.PASEO_PROFILE_TYPING_REPEATS ?? 3);
const workspaceDigit = process.env.PASEO_PROFILE_WORKSPACE_DIGIT ?? "1";
const headless = process.env.PASEO_PROFILE_HEADLESS !== "0";
const cpuProfilePath = process.env.PASEO_PROFILE_CPU_PATH;
const tracePath = process.env.PASEO_PROFILE_TRACE_PATH;
const alphabet = "abcdefghijklmnopqrstuvwxyz";
const measuredInput = Array.from({ length: sampleCount }, (_, index) => {
  if (scenario === "height-growth" && index % 2 === 0) {
    return { key: "Enter", text: "\n", shiftKey: true };
  }
  return { key: alphabet[index % alphabet.length], text: alphabet[index % alphabet.length] };
});
const measuredText = measuredInput.map((input) => input.text).join("");

function round(value) {
  return Math.round(value * 100) / 100;
}

function percentile(values, ratio) {
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function standardDeviation(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function longestRun(values, predicate) {
  let longest = 0;
  let current = 0;
  for (const value of values) {
    current = predicate(value) ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

function summarize(values) {
  return {
    p50Ms: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    p99Ms: round(percentile(values, 0.99)),
    maxMs: round(Math.max(...values)),
    stdevMs: round(standardDeviation(values)),
    over16Ms: values.filter((value) => value > 16.67).length,
    over24Ms: values.filter((value) => value > 24).length,
    over32Ms: values.filter((value) => value > 32).length,
    longestOver24Run: longestRun(values, (value) => value > 24),
  };
}

function keyCode(character) {
  const upper = character.toUpperCase();
  return {
    code: `Key${upper}`,
    windowsVirtualKeyCode: upper.charCodeAt(0),
  };
}

function reactScope(id) {
  if (
    id.startsWith("AgentComposerSection:") ||
    ["ComposerContent", "MessageInput", "ComposerTextSurface"].includes(id)
  ) {
    return "composer";
  }
  if (id.startsWith("AgentStreamSection:") || id.startsWith("AgentStreamView:")) {
    return "stream";
  }
  return "ancestor/root (includes descendants)";
}

function measuredInputKind(sequence) {
  if (measuredInput[sequence].key === "Enter") {
    return "newline";
  }
  if (measuredInput[sequence - 1]?.key === "Enter") {
    return "printable after newline";
  }
  return "printable";
}

async function installAppBootstrap(page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "@paseo:keyboard-shortcut-overrides",
      JSON.stringify({ "workspace-navigate-index-alt-digit-web": "Cmd+Digit" }),
    );

    const preserveRenderProfile = (original) =>
      function (state, unused, url) {
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
}

async function openComposer(page) {
  await installAppBootstrap(page);
  await page.goto(`${baseUrl}/?renderProfile=1`, { waitUntil: "commit" });
  await page.locator('[data-testid^="sidebar-workspace-row-"]').first().waitFor({
    timeout: 60_000,
  });
  await page.keyboard.press(`Meta+${workspaceDigit}`);
  const input = page.locator("[data-composer-input]").filter({ visible: true }).first();
  await input.waitFor({ state: "visible", timeout: 60_000 });
  await input.focus();
  await input.evaluate((element) => {
    if (!(element instanceof HTMLTextAreaElement)) {
      throw new Error("The visible composer input is not a textarea");
    }
    element.setSelectionRange(element.value.length, element.value.length);
  });
  return input;
}

async function prepareTextareaControl(page) {
  await page.setContent(`
    <style>
      html, body { margin: 0; width: 100%; height: 100%; }
      textarea {
        box-sizing: border-box;
        width: 760px;
        height: 180px;
        margin: 400px 340px;
        padding: 16px;
        border: 1px solid #aaa;
        resize: none;
        font: 15px/1.4 system-ui, sans-serif;
      }
    </style>
    <textarea aria-label="Plain textarea benchmark"></textarea>
  `);
  return page.getByRole("textbox", { name: "Plain textarea benchmark" });
}

async function installTypingProbe(page, target) {
  await page.evaluate((probeTarget) => {
    globalThis.__PASEO_TYPING_BENCHMARK_CLEANUP__?.();
    const element =
      probeTarget === "composer"
        ? [...document.querySelectorAll("[data-composer-input]")].find(
            (candidate) => candidate.getClientRects().length > 0,
          )
        : document.querySelector('textarea[aria-label="Plain textarea benchmark"]');
    if (!(element instanceof HTMLTextAreaElement)) {
      throw new Error(`Typing target ${probeTarget} was not found`);
    }
    const composerRoot = element.closest('[data-testid="message-input-root"]');
    const readLayout = () => ({
      inputHeight: element.getBoundingClientRect().height,
      composerHeight: composerRoot?.getBoundingClientRect().height ?? null,
      valueLength: element.value.length,
      lineCount: element.value.split("\n").length,
    });

    let sequence = 0;
    let frameScheduled = false;
    let paintedFrames = 0;
    const pending = [];
    const keydownAt = [];
    const inputAt = [];
    const paintedAt = [];
    const paintedLayout = [];
    const longTasks = [];
    const eventTimings = [];
    const longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      }
    });
    longTaskObserver.observe({ type: "longtask", buffered: true });
    const eventObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        eventTimings.push({
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
          processingStart: entry.processingStart,
          processingEnd: entry.processingEnd,
        });
      }
    });
    eventObserver.observe({ type: "event", buffered: true, durationThreshold: 0 });

    const onKeydown = (event) => {
      if (
        event.target !== element ||
        (event.key.length !== 1 && !(event.key === "Enter" && event.shiftKey)) ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      keydownAt[sequence] = performance.now();
      pending.push(sequence);
      sequence += 1;
    };
    const onInput = () => {
      const changedAt = performance.now();
      for (const pendingSequence of pending) {
        inputAt[pendingSequence] ??= changedAt;
      }
      if (frameScheduled || pending.length === 0) return;
      frameScheduled = true;
      requestAnimationFrame(() => {
        frameScheduled = false;
        paintedFrames += 1;
        const frameAt = performance.now();
        for (const completedSequence of pending.splice(0)) {
          paintedAt[completedSequence] = frameAt;
          paintedLayout[completedSequence] = readLayout();
        }
      });
    };
    element.addEventListener("keydown", onKeydown, true);
    element.addEventListener("input", onInput);
    globalThis.__PASEO_TYPING_BENCHMARK__ = {
      get receivedKeys() {
        return sequence;
      },
      get paintedFrames() {
        return paintedFrames;
      },
      keydownAt,
      inputAt,
      paintedAt,
      initialLayout: readLayout(),
      paintedLayout,
      longTasks,
      eventTimings,
      timeOrigin: performance.timeOrigin,
    };
    globalThis.__PASEO_TYPING_BENCHMARK_CLEANUP__ = () => {
      element.removeEventListener("keydown", onKeydown, true);
      element.removeEventListener("input", onInput);
      longTaskObserver.disconnect();
      eventObserver.disconnect();
    };
  }, target);
}

function groupReactCommits(samples) {
  const commits = new Map();
  for (const sample of samples) {
    const commit = commits.get(sample.commitTime) ?? {
      at: sample.commitTime,
      rootDurationMs: null,
      components: [],
    };
    if (sample.id === "WorkspaceDeck") {
      commit.rootDurationMs = sample.actualDuration;
    }
    commit.components.push({ id: sample.id, durationMs: sample.actualDuration });
    commits.set(sample.commitTime, commit);
  }
  return [...commits.values()].sort((left, right) => left.at - right.at);
}

function summarizeReactComponents(samples) {
  const totals = new Map();
  for (const sample of samples) {
    const current = totals.get(sample.id) ?? { id: sample.id, commits: 0, durationMs: 0 };
    current.commits += 1;
    current.durationMs += sample.actualDuration;
    totals.set(sample.id, current);
  }
  for (const component of totals.values()) {
    component.durationMs = round(component.durationMs);
  }
  return [...totals.values()].sort((left, right) => right.durationMs - left.durationMs);
}

function summarizeReactScopes(samples) {
  const totals = new Map();
  for (const sample of samples) {
    const scope = reactScope(sample.id);
    const current = totals.get(scope) ?? {
      scope,
      profilerCallbacks: 0,
      renderingCallbacks: 0,
      durationMs: 0,
      components: new Set(),
    };
    current.profilerCallbacks += 1;
    if (sample.actualDuration > 0.01) {
      current.renderingCallbacks += 1;
    }
    current.durationMs += sample.actualDuration;
    current.components.add(sample.id);
    totals.set(scope, current);
  }
  return [...totals.values()]
    .map((total) => ({
      scope: total.scope,
      profilerCallbacks: total.profilerCallbacks,
      renderingCallbacks: total.renderingCallbacks,
      durationMs: round(total.durationMs),
      components: [...total.components].sort(),
    }))
    .sort((left, right) => right.durationMs - left.durationMs);
}

function summarizeReactByInputKind(samples, keydownAt, paintedAt) {
  const totals = new Map();
  for (const sample of samples) {
    const sequence = keydownAt.findIndex(
      (startedAt, index) =>
        sample.commitTime >= startedAt &&
        sample.commitTime < (keydownAt[index + 1] ?? paintedAt[index] + cadenceMs),
    );
    if (sequence === -1) continue;
    const inputKind = measuredInputKind(sequence);
    const scope = reactScope(sample.id);
    const key = `${inputKind}:${scope}`;
    const current = totals.get(key) ?? {
      inputKind,
      scope,
      commits: new Set(),
      renderingCommits: new Set(),
      durationMs: 0,
    };
    current.commits.add(sample.commitTime);
    if (sample.actualDuration > 0.01) {
      current.renderingCommits.add(sample.commitTime);
    }
    current.durationMs += sample.actualDuration;
    totals.set(key, current);
  }
  return [...totals.values()]
    .map((total) => ({
      inputKind: total.inputKind,
      scope: total.scope,
      commits: total.commits.size,
      renderingCommits: total.renderingCommits.size,
      durationMs: round(total.durationMs),
    }))
    .sort(
      (left, right) =>
        left.inputKind.localeCompare(right.inputKind) || left.scope.localeCompare(right.scope),
    );
}

function summarizeHeightGrowth(initialLayout, layout) {
  const changes = [];
  const textAfterNewlineShifts = [];
  for (let sequence = 0; sequence < layout.length; sequence += 1) {
    const previous = sequence === 0 ? initialLayout : layout[sequence - 1];
    const current = layout[sequence];
    if (!previous || !current) continue;
    const inputDelta = round(current.inputHeight - previous.inputHeight);
    const composerDelta =
      current.composerHeight === null || previous.composerHeight === null
        ? null
        : round(current.composerHeight - previous.composerHeight);
    if (inputDelta !== 0 || (composerDelta !== null && composerDelta !== 0)) {
      const change = {
        sequence,
        key: measuredInput[sequence].key,
        inputDelta,
        composerDelta,
        inputHeight: current.inputHeight,
        composerHeight: current.composerHeight,
        lineCount: current.lineCount,
      };
      changes.push(change);
      if (
        sequence > 0 &&
        measuredInput[sequence - 1].key === "Enter" &&
        measuredInput[sequence].key !== "Enter"
      ) {
        textAfterNewlineShifts.push(change);
      }
    }
  }
  return {
    initial: initialLayout,
    final: layout.at(-1) ?? null,
    changes,
    textAfterNewlineShifts,
  };
}

function summarizeReactCommitShapes(commits) {
  const shapes = new Map();
  for (const commit of commits) {
    const ids = commit.components
      .filter((component) =>
        ["ComposerContent", "MessageInput", "ComposerTextSurface"].includes(component.id),
      )
      .map((component) => component.id)
      .sort();
    const key = ids.join(" + ") || "outside composer";
    const current = shapes.get(key) ?? { shape: key, commits: 0, rootDurationMs: 0 };
    current.commits += 1;
    current.rootDurationMs += commit.rootDurationMs ?? 0;
    shapes.set(key, current);
  }
  for (const shape of shapes.values()) {
    shape.rootDurationMs = round(shape.rootDurationMs);
  }
  return [...shapes.values()].sort((left, right) => right.rootDurationMs - left.rootDurationMs);
}

async function dispatchMeasuredInput(page, inputs) {
  const session = await page.context().newCDPSession(page);
  const dispatchedAt = Array.from({ length: inputs.length });
  const scheduledAt = Array.from({ length: inputs.length });
  const now = () => performance.timeOrigin + performance.now();
  const startedAt = now() + 100;
  const dispatches = [];

  await Promise.all(
    inputs.map(async (input, sequence) => {
      const dueAt = startedAt + sequence * cadenceMs;
      scheduledAt[sequence] = dueAt;
      const waitMs = dueAt - now();
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      dispatchedAt[sequence] = now();
      const key =
        input.key === "Enter" ? { code: "Enter", windowsVirtualKeyCode: 13 } : keyCode(input.key);
      const modifiers = input.shiftKey ? 8 : 0;
      dispatches.push(
        session.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: input.key,
          text: input.key === "Enter" ? "\r" : input.text,
          unmodifiedText: input.key === "Enter" ? "\r" : input.text,
          modifiers,
          ...key,
        }),
        session.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: input.key,
          modifiers,
          ...key,
        }),
      );
    }),
  );
  await Promise.all(dispatches);
  await session.detach();
  return { dispatchedAt, scheduledAt };
}

async function waitForMeasurement(page, expectedKeys) {
  await page.waitForFunction(
    (count) => globalThis.__PASEO_TYPING_BENCHMARK__?.receivedKeys === count,
    expectedKeys,
    { timeout: 15_000 },
  );
  await page.waitForFunction(
    (count) =>
      globalThis.__PASEO_TYPING_BENCHMARK__?.paintedAt.filter(Number.isFinite).length === count,
    expectedKeys,
    { timeout: 15_000 },
  );
}

async function measureTarget(page, input, target, originalText) {
  await input.fill(originalText);
  await input.focus();
  await input.evaluate((element) => {
    element.setSelectionRange(element.value.length, element.value.length);
  });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await installTypingProbe(page, target);
  await page.evaluate(() => globalThis.__PASEO_RESET_RENDER_PROFILE__?.());
  const { dispatchedAt, scheduledAt } = await dispatchMeasuredInput(page, measuredInput);
  await waitForMeasurement(page, measuredText.length);

  const diagnostics = await page.evaluate(() => ({
    state: globalThis.__PASEO_TYPING_BENCHMARK__,
    commits: globalThis.__PASEO_RENDER_PROFILE__ ?? [],
    renderReasons: globalThis.__PASEO_RENDER_PROFILE_REASONS__ ?? {},
    value: document.activeElement?.value ?? null,
  }));
  if (diagnostics.value !== `${originalText}${measuredText}`) {
    throw new Error(
      `Typing target lost input: expected ${measuredText.length} appended characters`,
    );
  }

  const state = diagnostics.state;
  const latencies = state.paintedAt.map((paintedAt, index) => paintedAt - state.keydownAt[index]);
  const processing = state.inputAt.map((inputAt, index) => inputAt - state.keydownAt[index]);
  const dispatchLateness = dispatchedAt.map((dispatched, index) => dispatched - scheduledAt[index]);
  const commits = groupReactCommits(diagnostics.commits);
  const slowSamples = latencies
    .map((latencyMs, sequence) => {
      const startedAt = state.keydownAt[sequence];
      const completedAt = state.paintedAt[sequence];
      const attributedCommits = commits.filter(
        (commit) => commit.at >= startedAt && commit.at <= completedAt,
      );
      return {
        sequence,
        latencyMs: round(latencyMs),
        inputMs: round(processing[sequence]),
        reactCommits: attributedCommits.length,
        rootReactDurationMs: round(
          attributedCommits.reduce((sum, commit) => sum + (commit.rootDurationMs ?? 0), 0),
        ),
        components: [
          ...new Set(
            attributedCommits.flatMap((commit) =>
              commit.components
                .filter((component) => component.durationMs >= 0.5)
                .map((component) => component.id),
            ),
          ),
        ],
      };
    })
    .filter((sample) => sample.latencyMs > 16.67)
    .sort((left, right) => right.latencyMs - left.latencyMs)
    .slice(0, 20);
  const rootCommits = commits.filter((commit) => commit.rootDurationMs !== null);

  return {
    target,
    sampleCount: measuredText.length,
    cadenceMs,
    ...summarize(latencies),
    inputProcessing: summarize(processing),
    p95DispatchLatenessMs: round(percentile(dispatchLateness, 0.95)),
    maxDispatchLatenessMs: round(Math.max(...dispatchLateness)),
    coalescedFrames: measuredText.length - state.paintedFrames,
    reactCommitCount: rootCommits.length,
    rootReactDurationMs: round(rootCommits.reduce((sum, commit) => sum + commit.rootDurationMs, 0)),
    reactComponents: summarizeReactComponents(diagnostics.commits),
    reactScopes: summarizeReactScopes(diagnostics.commits),
    reactByInputKind: summarizeReactByInputKind(
      diagnostics.commits,
      state.keydownAt,
      state.paintedAt,
    ),
    reactRenderReasons: diagnostics.renderReasons,
    reactCommitShapes: summarizeReactCommitShapes(commits),
    heightGrowth: summarizeHeightGrowth(state.initialLayout, state.paintedLayout),
    longTasks: state.longTasks,
    slowSamples,
  };
}

async function warmTarget(page, input, originalText) {
  await input.fill(originalText);
  await input.focus();
  await input.evaluate((element) => {
    element.setSelectionRange(element.value.length, element.value.length);
  });
  await page.keyboard.type("warmupwarmupwarmupwarmupwarmup", { delay: 5 });
  await input.fill(originalText);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

async function captureCpuProfile(page, input, originalText) {
  const session = await page.context().newCDPSession(page);
  await input.fill(originalText);
  await input.focus();
  await installTypingProbe(page, "composer");
  await session.send("Profiler.enable");
  await session.send("Profiler.setSamplingInterval", { interval: 100 });
  await session.send("Profiler.start");
  try {
    await dispatchMeasuredInput(page, measuredInput);
    await waitForMeasurement(page, measuredText.length);
  } finally {
    const { profile } = await session.send("Profiler.stop");
    await session.send("Profiler.disable");
    await session.detach();
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

async function captureTrace(page, input, originalText) {
  const session = await page.context().newCDPSession(page);
  const tracingComplete = new Promise((resolve) =>
    session.once("Tracing.tracingComplete", resolve),
  );
  await input.fill(originalText);
  await input.focus();
  await installTypingProbe(page, "composer");
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
  try {
    await dispatchMeasuredInput(page, measuredInput);
    await waitForMeasurement(page, measuredText.length);
  } finally {
    await session.send("Tracing.end");
    const completed = await tracingComplete;
    const trace = await readCdpStream(session, completed.stream);
    await writeFile(tracePath, trace);
    await session.detach();
  }
}

async function main() {
  const browser = await chromium.launch({ headless });
  const composerPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const textareaPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  let composerInput;
  let originalText;
  const runs = [];

  try {
    composerInput = await openComposer(composerPage);
    originalText = await composerInput.inputValue();
    const textareaInput = await prepareTextareaControl(textareaPage);
    await warmTarget(composerPage, composerInput, originalText);
    await warmTarget(textareaPage, textareaInput, "");

    for (let repeat = 0; repeat < repeatCount; repeat += 1) {
      if (repeat % 2 === 0) {
        runs.push(await measureTarget(composerPage, composerInput, "composer", originalText));
        runs.push(await measureTarget(textareaPage, textareaInput, "textarea", ""));
      } else {
        runs.push(await measureTarget(textareaPage, textareaInput, "textarea", ""));
        runs.push(await measureTarget(composerPage, composerInput, "composer", originalText));
      }
    }

    if (cpuProfilePath) {
      await captureCpuProfile(composerPage, composerInput, originalText);
    }
    if (tracePath) {
      await captureTrace(composerPage, composerInput, originalText);
    }

    console.log(
      JSON.stringify(
        {
          appUrl: baseUrl,
          scenario,
          cadenceMs,
          sampleCount,
          repeatCount,
          reactScopeNote:
            "Profiler boundaries are nested. Ancestor/root durations include descendant work and must not be added to composer or stream durations.",
          cpuProfilePath: cpuProfilePath ?? null,
          tracePath: tracePath ?? null,
          runs,
        },
        null,
        2,
      ),
    );
  } finally {
    if (composerInput && originalText !== undefined) {
      await composerInput.fill(originalText).catch(() => undefined);
    }
    await browser.close();
  }
}

await main();
