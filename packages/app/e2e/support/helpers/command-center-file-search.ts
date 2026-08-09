import { expect, type Locator, type Page } from "@playwright/test";
import { daemonWsRoutePattern } from "./daemon-port";

type WebSocketMessage = string | Buffer;

interface SurfaceRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

interface LayoutObservation {
  active: boolean;
  layoutShift: number;
  samples: Record<string, SurfaceRect[]>;
}

type LayoutOracleWindow = Window & {
  __commandCenterLayoutObservation?: LayoutObservation;
};

const SURFACE_SELECTORS = {
  panel: '[data-testid="command-center-panel"]',
  header: '[data-testid="command-center-header"]',
  input: '[data-testid="command-center-input"]',
  results: '[data-testid="command-center-results"]',
  scope: '[data-testid="command-center-files-scope"]',
  fileRow: '[data-testid^="command-center-file-row-"]',
  fileIcon: '[data-testid="command-center-file-icon"]',
  fileLine: '[data-testid="command-center-file-line"]',
} as const;

function parseSessionMessage(message: WebSocketMessage): Record<string, unknown> | null {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  try {
    const envelope = JSON.parse(raw) as { type?: unknown; message?: unknown };
    return envelope.type === "session" && envelope.message && typeof envelope.message === "object"
      ? (envelope.message as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function delayDirectorySuggestionResponses(page: Page, delayMs = 400): Promise<void> {
  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const sessionMessage = parseSessionMessage(message);
      if (sessionMessage?.type === "directory_suggestions_response") {
        setTimeout(() => ws.send(message), delayMs);
        return;
      }
      ws.send(message);
    });
  });
}

export async function failDirectorySuggestionRequests(page: Page): Promise<void> {
  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const sessionMessage = parseSessionMessage(message);
      if (sessionMessage?.type === "directory_suggestions_request") {
        const requestId = sessionMessage.requestId;
        if (typeof requestId === "string") {
          ws.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "rpc_error",
                payload: {
                  requestId,
                  requestType: "directory_suggestions_request",
                  error: "Test file search transport failure.",
                  code: "transport",
                },
              },
            }),
          );
        }
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
}

export async function startCommandCenterLayoutObservation(page: Page): Promise<void> {
  await page.evaluate((selectors) => {
    const oracleWindow = window as LayoutOracleWindow;
    const observation: LayoutObservation = { active: true, layoutShift: 0, samples: {} };
    oracleWindow.__commandCenterLayoutObservation = observation;

    const observedElements = new WeakSet<Element>();
    const resizeObserver = new ResizeObserver(record);
    const mutationObserver = new MutationObserver(discover);

    function record(): void {
      if (!observation.active) return;
      for (const [name, selector] of Object.entries(selectors)) {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        (observation.samples[name] ??= []).push({
          height: rect.height,
          width: rect.width,
          x: rect.x,
          y: rect.y,
        });
      }
    }

    function discover(): void {
      for (const selector of Object.values(selectors)) {
        const element = document.querySelector(selector);
        if (!element || observedElements.has(element)) continue;
        observedElements.add(element);
        resizeObserver.observe(element);
      }
      record();
    }

    mutationObserver.observe(document.body, { attributes: true, childList: true, subtree: true });
    discover();

    const sampleFrame = () => {
      if (!observation.active) {
        mutationObserver.disconnect();
        resizeObserver.disconnect();
        return;
      }
      record();
      requestAnimationFrame(sampleFrame);
    };
    requestAnimationFrame(sampleFrame);

    if (typeof PerformanceObserver !== "undefined") {
      try {
        const performanceObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            observation.layoutShift += (entry as PerformanceEntry & { value?: number }).value ?? 0;
          }
        });
        performanceObserver.observe({ type: "layout-shift", buffered: false });
      } catch {
        // LayoutShift is diagnostic-only on engines that do not expose it.
      }
    }
  }, SURFACE_SELECTORS);
}

export async function expectStableCommandCenterLayout(page: Page): Promise<void> {
  await page.waitForTimeout(500);
  const observation = await page.evaluate(() => {
    const state = (window as LayoutOracleWindow).__commandCenterLayoutObservation;
    if (!state) throw new Error("Command center layout observer was not installed");
    state.active = false;
    return state;
  });

  for (const surface of Object.keys(SURFACE_SELECTORS)) {
    const samples = observation.samples[surface] ?? [];
    expect(samples.length, `${surface}: ${JSON.stringify(observation)}`).toBeGreaterThan(0);
    for (const dimension of ["height", "width", "x", "y"] as const) {
      const values = samples.map((sample) => sample[dimension]);
      expect(
        Math.max(...values) - Math.min(...values),
        `${surface}.${dimension}: ${JSON.stringify(samples)}`,
      ).toBeLessThanOrEqual(1);
    }
  }
  expect(observation.layoutShift, JSON.stringify(observation)).toBeLessThanOrEqual(0.001);
}

export async function expectOneLineTruncatedFileResult(
  row: Locator,
  input: { filename: string; path: string },
): Promise<void> {
  await expect(row).toContainText(`${input.filename} ${input.path}`);
  await expect(row.getByTestId("command-center-file-icon")).toBeVisible();
  const line = row.getByTestId("command-center-file-line");
  const filename = row.getByTestId("command-center-file-name");
  const filePath = row.getByTestId("command-center-file-path");
  const geometry = await Promise.all([
    row.boundingBox(),
    line.boundingBox(),
    filename.boundingBox(),
    filePath.boundingBox(),
    line.evaluate((element) => ({
      clientWidth: element.clientWidth,
      overflow: getComputedStyle(element).overflow,
      scrollWidth: element.scrollWidth,
      whiteSpace: getComputedStyle(element).whiteSpace,
    })),
  ]);
  const [rowBox, lineBox, filenameBox, pathBox, overflow] = geometry;
  expect(rowBox).not.toBeNull();
  expect(lineBox).not.toBeNull();
  expect(filenameBox).not.toBeNull();
  expect(pathBox).not.toBeNull();
  expect(rowBox?.height).toBe(36);
  expect(Math.abs((filenameBox?.y ?? 0) - (pathBox?.y ?? 0))).toBeLessThanOrEqual(1);
  expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);
  expect(overflow.overflow).toBe("hidden");
  expect(overflow.whiteSpace).toBe("nowrap");
}
