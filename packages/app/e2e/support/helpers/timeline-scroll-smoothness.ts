import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { seedMockAgentWorkspace, openAgentRoute, type MockAgentWorkspace } from "./mock-agent";
import { openAgentTimeline, expectTimelinePromptVisible } from "./timeline-pagination";
import { holdAssistantStream } from "./agent-timeline-gate";

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
export interface ScrollFrame {
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

export async function withStreamingReader(run: (agent: MockAgentWorkspace) => Promise<void>) {
  const section = "Read this paragraph while the response continues below. ".repeat(8);
  const response = [
    "```mermaid\nflowchart LR\n Start --> Review --> Done\n```",
    "```mermaid\nflowchart LR\n Nested --> Finished\n```",
    ...Array.from({ length: 40 }, (_, index) => `## Long section ${index}\n\n${section}`),
    "READER-STREAM-SETTLED",
  ].join("\n\n");
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "held-stream-reader-",
    title: "Held streaming paragraph",
    featureValues: {
      mockStreamingAssistantResponse: response,
      mockStreamingAssistantIntervalMs: 1,
    },
  });
  try {
    await run(agent);
  } finally {
    await agent.cleanup();
  }
}

export async function holdParagraphThroughCompletion(page: Page, agent: MockAgentWorkspace) {
  const stream = await holdAssistantStream(page, agent.agentId);
  await openAgentRoute(page, agent);
  await page.getByRole("textbox", { name: "Message agent...", exact: true }).waitFor();
  const scroll = page.getByTestId("agent-chat-scroll");
  const following = await scroll.evaluateHandle((viewport) => {
    const result = { stopped: false, maxGap: 0 };
    const frame = () => {
      if (result.stopped) return;
      result.maxGap = Math.max(
        result.maxGap,
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      );
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    return result;
  });
  await agent.client.sendAgentMessage(agent.agentId, "Stream the mixed response.");
  await stream.showUntil("Long section 12\n");
  await page
    .getByRole("heading", { name: "Long section 12", exact: true })
    .waitFor({ state: "attached" });
  // Exercise a reader whose producer has already finished; delivery must be gated.
  await agent.client.waitForFinish(agent.agentId, 30_000);
  await expect(page.getByTestId("mermaid-viewport")).toHaveCount(2);
  await expect(page.getByTestId("mermaid-viewport").nth(0)).toHaveCSS("opacity", "1");
  await expect(page.getByTestId("mermaid-viewport").nth(1)).toHaveCSS("opacity", "1");
  const maxFollowGap = await following.evaluate((result) => {
    result.stopped = true;
    return result.maxGap;
  });
  const bounds = await scroll.boundingBox();
  if (!bounds) throw new Error("Reader viewport is missing");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, -1600);
  await page.waitForTimeout(150);
  const paragraph = page.getByRole("heading", { name: "Long section 3", exact: true });
  await paragraph.waitFor({ state: "attached" });
  const recording = await paragraph.evaluateHandle((heading) => {
    if (!document.querySelector('[data-testid="turn-working-indicator"]')) {
      throw new Error("The stream completed before the reader detached");
    }
    const viewport = document.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
    const clip = viewport.getBoundingClientRect();
    viewport.scrollTop += heading.getBoundingClientRect().y - (clip.top + clip.height / 2);
    const baseline = heading.getBoundingClientRect().y;
    const initialTextLength = heading.closest('[data-testid="assistant-message"]')!.textContent!
      .length;
    const result = { maxDrift: 0, retained: true, textGrowth: 0, done: false };
    let stableAt = performance.now();
    let signature = "";
    const frame = (now: number) => {
      result.retained &&= heading.isConnected;
      const current = [...document.querySelectorAll("h2")].find(
        (n) => n.textContent === "Long section 3",
      );
      const textLength =
        current?.closest('[data-testid="assistant-message"]')?.textContent?.length ?? 0;
      result.textGrowth = Math.max(result.textGrowth, textLength - initialTextLength);
      if (current)
        result.maxDrift = Math.max(
          result.maxDrift,
          Math.abs(current.getBoundingClientRect().y - baseline),
        );
      const next = `${viewport.scrollHeight}:${viewport.scrollTop}:${current?.getBoundingClientRect().y}`;
      if (next !== signature) {
        signature = next;
        stableAt = now;
      }
      const complete =
        document.body.textContent?.includes("Worked for") &&
        document.body.textContent.includes("READER-STREAM-SETTLED") &&
        !document.querySelector('[data-testid="turn-working-indicator"]');
      if (complete && now - stableAt >= 750) {
        result.done = true;
        return;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    return result;
  });
  await expect(
    page.getByTestId("scroll-to-bottom-button").filter({ visible: true }).first(),
  ).toBeVisible();
  stream.release();
  await page.waitForFunction((result) => result.done, recording);
  return { ...(await recording.jsonValue()), maxFollowGap };
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
    let mounted = scroll.querySelectorAll("[data-history-row-id]").length;
    let unmounted = 0;
    const collectRows = (node: Node, rows: Set<Element>) => {
      if (!(node instanceof Element)) return;
      if (node.matches("[data-history-row-id]")) rows.add(node);
      for (const row of node.querySelectorAll("[data-history-row-id]")) rows.add(row);
    };
    const recordMutations = (records: MutationRecord[]) => {
      // A newly inserted container and its children can both appear in one
      // delivery. Count each DOM row once, including rows removed before paint.
      const added = new Set<Element>();
      const removed = new Set<Element>();
      for (const record of records) {
        for (const node of record.addedNodes) collectRows(node, added);
        for (const node of record.removedNodes) collectRows(node, removed);
      }
      mounted += added.size;
      unmounted += removed.size;
    };
    const mutations = new MutationObserver(recordMutations);
    mutations.observe(scroll, { childList: true, subtree: true });
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
      // Include rows mounted and removed in the same commit, before sampling.
      recordMutations(mutations.takeRecords());
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
        mutations.disconnect();
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

export function findScrollJumps(frames: ScrollFrame[]) {
  return frames.flatMap((current, index) => {
    const previous = frames[index - 1];
    if (!previous?.anchor) return [];
    // Wheel input can move the reading line onto an image before it expands.
    // Follow that intended row, not text now below the image.
    const recent = frames.findLast((frame) => frame.at <= previous.at - 100);
    const wheelBudget = current.wheelTotal - (recent?.wheelTotal ?? 0);
    const currentRows = new Map(current.rows.map((row) => [row.id, row]));
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
    // scrollTop also includes virtualizer estimate corrections. Locate the row
    // entered by wheel input from its viewport movement instead. Its old height
    // identifies the reader before a simultaneous image resize takes effect.
    const intendedRow = previous.rows.find((row) => {
      const next = currentRows.get(row.id);
      if (!next || idle || wheelBudget <= 0) return false;
      const travel = next.top - row.top;
      return (
        travel >= -8 &&
        travel <= Math.min(wheelBudget, previous.scrollTop) + 32 &&
        (next.top <= 8 || current.scrollTop === 0) &&
        next.top + row.height > 8
      );
    });
    const enteredRowResize = intendedRow
      ? previous.rows.reduce((growth, row) => {
          if (row.top < intendedRow.top || row.top >= before.top) return growth;
          const height = currentRows.get(row.id)?.height ?? row.height;
          return growth + height - row.height;
        }, 0)
      : 0;
    const readingMovement = movement - enteredRowResize;
    const excessForward = readingMovement > wheelBudget + 32;
    // Upward wheel input moves the same text DOWN the viewport. A negative move
    // is a reversal, independent of legitimate scrollTop compensation on prepend.
    if (readingMovement >= -8 && (!idle || Math.abs(readingMovement) <= 8) && !excessForward)
      return [];
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
}

export async function reportScrollJumps(
  page: Page,
  testInfo: TestInfo,
  frames: ScrollFrame[],
  pages: TimelinePage[],
): Promise<void> {
  const jumps = findScrollJumps(frames);
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
    imageLoads: frames[frames.length - 1].imageLoads,
    mounted: frames[frames.length - 1].mounted,
    unmounted: frames[frames.length - 1].unmounted,
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
  await attachTimelineScreenshot(page, testInfo, "scroll-end");
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
    summary.mounted - summary.unmounted,
    "row counters must balance against the final DOM",
  ).toBe(frames[frames.length - 1].rows.length);
  const uniqueRows = new Set(frames.flatMap((frame) => frame.rows.map((row) => row.id))).size;
  expect(
    summary.mounted,
    "prepending must not mount a discarded range before correcting the viewport",
  ).toBeLessThanOrEqual(uniqueRows * 1.25);
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

/** Hold real image bytes until the reader has reached its placeholder. */
export async function expectImageSpaceReserved(page: Page, testInfo: TestInfo): Promise<void> {
  let released = false;
  const pending = new Set<() => void>();
  const server = createServer((_request, response) => {
    const send = () => {
      response.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
      response.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="#369"/></svg>',
      );
    };
    if (released) send();
    else pending.add(send);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Image server did not listen");
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "reserved-timeline-image-",
      title: "Reserved image geometry",
      featureValues: {
        mockAssistantResponses: [
          `Before the image.\n\n![Reserved image](http://127.0.0.1:${address.port}/image.svg)\n\nText below the image.`,
        ],
      },
    });
    try {
      await agent.client.sendAgentMessage(agent.agentId, "Show the delayed image");
      await agent.client.waitForFinish(agent.agentId, 15_000);
      await openAgentTimeline(page, agent);
      await expectTimelinePromptVisible(page, "Show the delayed image");
      const image = page.getByRole("button", { name: "Reserved image", exact: true }).first();
      await expect(image).toBeVisible();
      const before = await image.boundingBox();
      await attachTimelineScreenshot(page, testInfo, "image-placeholder");
      released = true;
      for (const send of pending) send();
      await expect
        .poll(() =>
          image.evaluate((element) => {
            const img =
              element instanceof HTMLImageElement ? element : element.querySelector("img");
            return img?.naturalWidth;
          }),
        )
        .toBe(240);
      await expect
        .poll(async () => {
          return image.evaluate((element: HTMLImageElement) =>
            Math.round((element.naturalWidth / element.naturalHeight) * 100),
          );
        })
        .toBe(150);
      const after = await image.boundingBox();
      await attachTimelineScreenshot(page, testInfo, "image-loaded");
      expect(before?.height, "reserve the final image height before the HTTP response").toBe(
        after?.height,
      );
    } finally {
      await agent.cleanup();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function attachTimelineScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.getByTestId("agent-chat-scroll").screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}
