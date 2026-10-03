import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { seedMockAgentWorkspace, type MockAgentWorkspace } from "./mock-agent";
import { openAgentTimeline, expectTimelinePromptVisible } from "./timeline-pagination";

export const scrollCadences = [
  { name: "slow", delta: 160, intervalMs: 50, steps: 1000 },
  { name: "medium", delta: 480, intervalMs: 32, steps: 400 },
  { name: "fast", delta: 1200, intervalMs: 16, steps: 180 },
] as const;

type Cadence = (typeof scrollCadences)[number];
interface RowFrame {
  id: string;
  top: number;
  height: number;
}
interface ScrollFrame {
  at: number;
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  virtualized: boolean;
  loading: boolean;
  rows: RowFrame[];
  anchor: string | null;
  wheelTotal: number;
  lastWheelAt: number;
  inputFinishedAt: number | null;
  imageLoads: number;
  mounted: number;
  unmounted: number;
}
interface Recording {
  frames: ScrollFrame[];
  finishInput(): void;
  stop(): void;
}
interface TimelinePage {
  direction: string;
  count: number;
  hasOlder: boolean;
  at: number;
}

/** Real HTTP image responses, with intrinsic dimensions unavailable until the response arrives. */
export async function withVariedTimeline(
  run: (agent: MockAgentWorkspace, newestPrompt: string) => Promise<void>,
): Promise<void> {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((request, response) => {
    const portrait = request.url?.includes("portrait");
    const timer = setTimeout(
      () => {
        timers.delete(timer);
        response.writeHead(200, {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        });
        response.end(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${portrait ? 320 : 960}" height="${portrait ? 640 : 240}"><rect width="100%" height="100%" fill="${portrait ? "#936" : "#369"}"/><text x="20" y="50" fill="white" font-size="24">Delayed ${portrait ? "portrait" : "landscape"}</text></svg>`,
        );
      },
      portrait ? 900 : 350,
    );
    timers.add(timer);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Image server did not listen");
  const imageUrl = `http://127.0.0.1:${address.port}`;
  let agent: MockAgentWorkspace | undefined;
  try {
    agent = await seedMockAgentWorkspace({
      repoPrefix: "timeline-scroll-smoothness-",
      title: "Varied timeline scroll reproduction",
      featureValues: {
        mockAssistantResponses: Array.from({ length: 70 }, (_, turn) =>
          [
            `## Review of turn ${turn}`,
            "A short response followed by blocks with different heights. Read the comparison, inspect the screenshot, and continue to the next turn.",
            "| Component | Observation | Next step |\n| --- | --- | --- |\n| Pagination | Older turns arrive together | Keep the visible text anchored |\n| Images | Intrinsic sizes arrive later | Preserve the reading position |\n| Virtualization | Estimated heights become measured heights | Keep wheel input moving upward |",
            `![Delayed landscape](${imageUrl}/${turn}/landscape.svg)`,
            "```typescript\nconst viewport = { top: 0, height: 800 };\nfor (const row of history) {\n  inspect(row, viewport);\n}\n```",
            "> Keep reading while content above the viewport changes.",
            "- Short item\n- A longer item that wraps when the available width is smaller and adds another height variation\n- Final item",
            `![Delayed portrait](${imageUrl}/${turn}/portrait.svg)`,
            "Review complete. The next prompt starts a separate turn.",
          ].join("\n\n"),
        ),
      },
    });
    for (let turn = 0; turn < 70; turn += 1) {
      await agent.client.sendAgentMessage(
        agent.agentId,
        `Review turn ${turn}. ${"Compare the image and table with the earlier result. ".repeat(1 + (turn % 4))}`,
      );
      await agent.client.waitForFinish(agent.agentId, 15_000);
    }
    await run(
      agent,
      `Review turn 69. ${"Compare the image and table with the earlier result. ".repeat(2)}`,
    );
  } finally {
    await agent?.cleanup();
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export function observeTimelinePages(page: Page, agentId: string): TimelinePage[] {
  const pages: TimelinePage[] = [];
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      const envelope = JSON.parse(String(payload));
      const message = envelope.message;
      if (message?.type !== "fetch_agent_timeline_response" || message.payload.agentId !== agentId)
        return;
      pages.push({
        direction: message.payload.direction,
        count: message.payload.entries.length,
        hasOlder: message.payload.hasOlder,
        at: Date.now(),
      });
    });
  });
  return pages;
}

export async function openOnlyTimelineTail(
  page: Page,
  agent: MockAgentWorkspace,
  newestPrompt: string,
  pages: TimelinePage[],
): Promise<void> {
  await page.addInitScript(() => Reflect.set(globalThis, "__PASEO_RENDER_PROFILE_ENABLED__", true));
  await openAgentTimeline(page, agent);
  await expectTimelinePromptVisible(page, newestPrompt.trim());
  await expect
    .poll(() => pages.filter((entry) => entry.direction === "tail").length)
    .toBeGreaterThanOrEqual(1);

  expect(pages[0]).toMatchObject({ direction: "tail", hasOlder: true });
  expect(pages[0].count).toBe(40);
  expect(pages.filter((entry) => entry.direction === "tail")).toHaveLength(1);
  expect(
    pages.filter((entry) => entry.direction === "after").every((entry) => entry.count === 0),
  ).toBe(true);
  await expect(page.getByText(/^Review turn 0\./)).toHaveCount(0);
  // Start each cadence after the tail's initial image loads and bottom anchoring.
  await page.waitForTimeout(1500);
  expect(pages.filter((entry) => entry.direction === "before")).toHaveLength(0);
}

export async function recordUpwardTraversal(
  page: Page,
  cadence: Cadence,
  testInfo: TestInfo,
): Promise<ScrollFrame[]> {
  const stopTrace = await traceScrollIfRequested(page, testInfo, cadence);
  const timeline = page.getByTestId("agent-chat-scroll");
  await timeline.hover();
  await timeline.evaluate((viewport) => {
    const scroll = viewport as HTMLElement;
    const frames: ScrollFrame[] = [];
    let frame = 0;
    let wheelTotal = 0;
    let lastWheelAt = -Infinity;
    let inputFinishedAt: number | null = null;
    let imageLoads = 0;
    let mounted = 0;
    let unmounted = 0;
    let previousIds = new Set<string>();
    const wheel = (event: WheelEvent) => {
      wheelTotal += -event.deltaY;
      lastWheelAt = performance.now();
    };
    const imageLoad = (event: Event) => {
      if (event.target instanceof HTMLImageElement) imageLoads += 1;
    };
    scroll.addEventListener("wheel", wheel, { passive: true });
    scroll.addEventListener("load", imageLoad, true);
    const observed = new Set<Element>();
    const capture = (replaceLast: boolean) => {
      const rect = scroll.getBoundingClientRect();
      const elements = Array.from(scroll.querySelectorAll<HTMLElement>("[data-history-row-id]"));
      const current = new Set<Element>([scroll, ...elements]);
      if (scroll.firstElementChild) current.add(scroll.firstElementChild);
      for (const element of observed) {
        if (!current.has(element)) {
          resizeObserver.unobserve(element);
          observed.delete(element);
        }
      }
      for (const element of current) {
        if (!observed.has(element)) {
          resizeObserver.observe(element);
          observed.add(element);
        }
      }
      const rows = elements.map((row) => {
        const box = row.getBoundingClientRect();
        return { id: row.dataset.historyRowId!, top: box.top - rect.top, height: box.height };
      });
      const ids = new Set(rows.map((row) => row.id));
      mounted += [...ids].filter((id) => !previousIds.has(id)).length;
      unmounted += [...previousIds].filter((id) => !ids.has(id)).length;
      previousIds = ids;
      // Preserve the row crossing the reading line. Rows below an expanding
      // visible image legitimately move even when the reading position is stable.
      const anchor = rows.find((row) => row.top < rect.height && row.top + row.height > 8);
      const snapshot: ScrollFrame = {
        at: performance.now(),
        scrollTop: scroll.scrollTop,
        scrollHeight: scroll.scrollHeight,
        viewportHeight: rect.height,
        rows,
        anchor: anchor?.id ?? null,
        virtualized: scroll.id.includes("virtualized"),
        loading: !!scroll.querySelector('[data-testid="load-older-history-spinner"]'),
        wheelTotal,
        lastWheelAt,
        inputFinishedAt,
        imageLoads,
        mounted,
        unmounted,
      };
      if (replaceLast && frames.length > 0) frames[frames.length - 1] = snapshot;
      else frames.push(snapshot);
    };
    // rAF precedes ResizeObserver. Refresh that frame after resize delivery so
    // it represents the final layout, not geometry repaired before the paint.
    const resizeObserver = new ResizeObserver(() => capture(true));
    const sample = () => {
      capture(false);
      frame = requestAnimationFrame(sample);
    };
    const recording: Recording = {
      frames,
      finishInput() {
        inputFinishedAt = performance.now();
      },
      stop() {
        cancelAnimationFrame(frame);
        resizeObserver.disconnect();
        scroll.removeEventListener("wheel", wheel);
        scroll.removeEventListener("load", imageLoad, true);
      },
    };
    Reflect.set(window, "__timelineScrollRecording", recording);
    const reset = Reflect.get(window, "__PASEO_RESET_RENDER_PROFILE__");
    if (typeof reset === "function") reset();
    sample();
  });
  // No settling between inputs: exercise wheel input overlapping prepend and measurement.
  for (let step = 0; step < cadence.steps; step += 1) {
    await page.mouse.wheel(0, -cadence.delta);
    await page.waitForTimeout(cadence.intervalMs);
  }
  await page.evaluate(() => {
    (Reflect.get(window, "__timelineScrollRecording") as Recording).finishInput();
  });
  await page.waitForTimeout(1500);
  await stopTrace();
  return page.evaluate(() => {
    const recording = Reflect.get(window, "__timelineScrollRecording") as Recording;
    recording.stop();
    return recording.frames;
  });
}

export async function reportScrollJumps(
  page: Page,
  testInfo: TestInfo,
  frames: ScrollFrame[],
  pages: TimelinePage[],
): Promise<void> {
  const jumps = frames.flatMap((current, index) => {
    const previous = frames[index - 1];
    if (!previous?.anchor) return [];
    // Wheel input can move the reading line onto an image before it expands.
    // Follow that intended row, not text now below the image.
    const inputDelta = current.wheelTotal - previous.wheelTotal;
    const readingLine = 8 - Math.min(inputDelta, previous.scrollTop);
    const currentRows = new Map(current.rows.map((row) => [row.id, row]));
    const intendedRow = previous.rows.find((row) => row.top + row.height > readingLine);
    const intendedHeight = intendedRow && currentRows.get(intendedRow.id)?.height;
    const enteredRowGrowth =
      inputDelta > 0 && intendedRow && intendedHeight !== undefined
        ? Math.max(0, intendedHeight - intendedRow.height)
        : 0;
    const anchor = previous.anchor;
    const before = currentRows.has(anchor)
      ? previous.rows.find((row) => row.id === anchor)!
      : previous.rows
          .filter((row) => currentRows.has(row.id))
          .sort((left, right) => Math.abs(left.top - 8) - Math.abs(right.top - 8))[0];
    if (!before) {
      throw new Error(`No shared reading geometry between frames ${index - 1} and ${index}`);
    }
    const after = currentRows.get(before.id)!;
    const movement = after.top - before.top;
    // A busy main thread can deliver wheel movement hundreds of milliseconds
    // after its event. Only assert idle stability after the driver stops input.
    const idle = current.inputFinishedAt !== null && previous.at - current.inputFinishedAt > 250;
    const recent = frames.findLast((frame) => frame.at <= previous.at - 100);
    const wheelBudget = current.wheelTotal - (recent?.wheelTotal ?? 0);
    const excessForward = movement > wheelBudget + enteredRowGrowth + 32;
    // Upward wheel input moves the same text DOWN the viewport. A negative move
    // is a reversal, independent of legitimate scrollTop compensation on prepend.
    if (movement >= -8 && (!idle || Math.abs(movement) <= 8) && !excessForward) return [];
    return [
      {
        frame: index,
        at: current.at,
        row: before.id,
        movement,
        idle,
        excessForward,
        resizedRows: current.rows.flatMap((row) => {
          const old = previous.rows.find((candidate) => candidate.id === row.id);
          return old && old.height !== row.height
            ? [{ id: row.id, before: old.height, after: row.height }]
            : [];
        }),
        loading: current.loading || previous.loading,
        virtualized: current.virtualized,
        heightChange: current.scrollHeight - previous.scrollHeight,
        imageLoads: current.imageLoads - previous.imageLoads,
        frameGapMs: current.at - previous.at,
      },
    ];
  });
  const react = await page.evaluate(() => Reflect.get(window, "__PASEO_RENDER_PROFILE__") ?? []);
  const gaps = frames
    .slice(1)
    .map((frame, index) => frame.at - frames[index].at)
    .sort((a, b) => a - b);
  const summary = {
    browserTimeOrigin: await page.evaluate(() => performance.timeOrigin),
    frames: frames.length,
    pages,
    jumpCount: jumps.length,
    worstReversePx: Math.max(0, ...jumps.map((jump) => -jump.movement)),
    frameGapP95Ms: gaps[Math.floor(gaps.length * 0.95)],
    frameGapMaxMs: gaps.at(-1),
    imageLoads: frames.at(-1)?.imageLoads,
    mounted: frames.at(-1)?.mounted,
    unmounted: frames.at(-1)?.unmounted,
    jumps,
  };
  await writeFile(testInfo.outputPath("scroll-summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(testInfo.outputPath("scroll-frames.json"), JSON.stringify(frames));
  await writeFile(testInfo.outputPath("scroll-react-profile.json"), JSON.stringify(react));
  await testInfo.attach("scroll-summary", {
    body: JSON.stringify(summary, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach("scroll-frames", {
    body: JSON.stringify(frames),
    contentType: "application/json",
  });
  await testInfo.attach("scroll-react-profile", {
    body: JSON.stringify(react),
    contentType: "application/json",
  });
  await testInfo.attach("scroll-end", { body: await page.screenshot(), contentType: "image/png" });
  console.log(
    `[scroll] ${testInfo.title}: ${JSON.stringify({ ...summary, jumps: jumps.slice(0, 5) })}`,
  );
  expect(
    pages.filter((entry) => entry.direction === "before").length,
    "must exercise multiple older pages",
  ).toBeGreaterThanOrEqual(2);
  expect(
    frames.some((frame) => frame.virtualized),
    "must exercise virtualization",
  ).toBe(true);
  expect(summary.imageLoads, "must exercise image completion during traversal").toBeGreaterThan(0);
  expect(
    jumps,
    "visible text must not reverse direction while scrolling upward or move after input stops",
  ).toEqual([]);
}

async function traceScrollIfRequested(
  page: Page,
  testInfo: TestInfo,
  cadence: Cadence,
): Promise<() => Promise<void>> {
  if (process.env.PASEO_TIMELINE_SCROLL_TRACE !== cadence.name) return async () => {};
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Tracing.start", {
    categories:
      "devtools.timeline,v8.execute,blink.user_timing,disabled-by-default-v8.cpu_profiler",
    transferMode: "ReturnAsStream",
  });
  return async () => {
    const completed = new Promise<string>((resolve) => {
      cdp.once("Tracing.tracingComplete", ({ stream }) => resolve(stream!));
    });
    await cdp.send("Tracing.end");
    const stream = await completed;
    const chunks: string[] = [];
    for (;;) {
      const chunk = await cdp.send("IO.read", { handle: stream });
      chunks.push(chunk.base64Encoded ? Buffer.from(chunk.data, "base64").toString() : chunk.data);
      if (chunk.eof) break;
    }
    await cdp.send("IO.close", { handle: stream });
    await cdp.detach();
    const path = testInfo.outputPath("scroll-chromium-trace.json");
    await writeFile(path, chunks.join(""));
    await testInfo.attach("scroll-chromium-trace", { path, contentType: "application/json" });
  };
}
