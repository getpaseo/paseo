import { afterEach, describe, expect, it } from "vitest";
import { mermaidRuntimeHtml } from "./html.gen";
import { parseMermaidRuntimeMessage, type MermaidRuntimeMessage } from "./messages";

const mountedFrames: HTMLIFrameElement[] = [];

function waitForRuntimeMessage(
  frame: HTMLIFrameElement,
  predicate: (message: MermaidRuntimeMessage) => boolean,
): Promise<MermaidRuntimeMessage> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", receive);
      reject(new Error("Timed out waiting for Mermaid runtime"));
    }, 10_000);
    function receive(event: MessageEvent): void {
      if (event.source !== frame.contentWindow) {
        return;
      }
      const message = parseMermaidRuntimeMessage(event.data);
      if (!message || !predicate(message)) {
        return;
      }
      window.clearTimeout(timeout);
      window.removeEventListener("message", receive);
      resolve(message);
    }
    window.addEventListener("message", receive);
  });
}

async function mountRuntime(
  size?: { width: number; height: number },
  options?: { allowSameOrigin?: boolean },
): Promise<HTMLIFrameElement> {
  const frame = document.createElement("iframe");
  frame.sandbox.add("allow-scripts");
  if (options?.allowSameOrigin) {
    frame.sandbox.add("allow-same-origin");
  }
  if (size) {
    frame.style.width = `${size.width}px`;
    frame.style.height = `${size.height}px`;
  }
  const ready = waitForRuntimeMessage(frame, (message) => message.type === "bridgeReady");
  frame.srcdoc = mermaidRuntimeHtml;
  document.body.append(frame);
  mountedFrames.push(frame);
  await ready;
  return frame;
}

function renderedSize(message: MermaidRuntimeMessage): { height: number; width: number } {
  if (message.type !== "rendered") {
    throw new Error(`Expected a rendered diagram, got ${message.type}`);
  }
  return { height: message.height, width: message.width };
}

function render(
  frame: HTMLIFrameElement,
  input: { revision: number; source: string },
): Promise<MermaidRuntimeMessage> {
  const response = waitForRuntimeMessage(
    frame,
    (message) =>
      message.type !== "bridgeReady" &&
      "revision" in message &&
      message.revision === input.revision,
  );
  frame.contentWindow?.postMessage(
    {
      type: "render",
      revision: input.revision,
      source: input.source,
      colorScheme: "dark",
      interactive: false,
    },
    "*",
  );
  return response;
}

afterEach(() => {
  for (const frame of mountedFrames.splice(0)) {
    frame.remove();
  }
});

describe("Mermaid sandbox runtime", () => {
  it("renders successive valid streaming prefixes and reports an invalid prefix", async () => {
    const frame = await mountRuntime();
    const firstSource = "flowchart TD\nA --> B";
    const secondSource = `${firstSource}\nB --> C`;

    const first = await render(frame, { revision: 1, source: firstSource });
    const invalid = await render(frame, { revision: 2, source: "not a mermaid diagram" });
    const second = await render(frame, { revision: 3, source: secondSource });

    expect(first).toMatchObject({ type: "rendered", revision: 1, source: firstSource });
    expect(invalid).toEqual({ type: "renderError", revision: 2 });
    expect(second).toMatchObject({ type: "rendered", revision: 3, source: secondSource });
  });

  /**
   * The host sizes this frame from the reported size, so a size that depends on the frame feeds
   * back: every re-render measures inside a frame the previous measurement already shrank by the
   * container's padding, and a streaming diagram ratchets down to a few pixels.
   */
  it("reports the same size whatever frame the host gives it", async () => {
    const source = "flowchart TD\nA[Start] --> B[Middle]\nB --> C[Ship]";
    const narrowFrame = await mountRuntime({ height: 60, width: 60 });
    const wideFrame = await mountRuntime({ height: 600, width: 900 });

    const narrow = await render(narrowFrame, { revision: 1, source });
    const wide = await render(wideFrame, { revision: 1, source });

    expect(renderedSize(narrow)).toEqual(renderedSize(wide));
  });

  /**
   * MermaidFenceHost renders the first revision inside a 240x240 measuring frame (or 0x0 before
   * ResizeObserver settles), then resizes the frame to the reported diagram size without
   * re-rendering. Diagrams such as xychart-beta set `width="100%"` and `viewBox="0 0 700 500"`
   * before measuring axis text with `getBoundingClientRect()`, so rendering directly in a narrow
   * frame shrinks measured glyph boxes and leaves the Y-axis title colliding with tick labels and
   * X-axis labels clipped at the bottom edge.
   */
  it("preserves unscaled SVG layout when rendered inside a narrow or zero-sized frame", async () => {
    const source = [
      "xychart-beta",
      '  title "Throughput by Stage (req/s)"',
      '  x-axis ["v1-base", "v2-parse", "v3-batch", "v4-cache", "v5-simd", "v6-final"]',
      '  y-axis "Throughput (req/s)" 92.5 --> 93.6',
      "  bar [92.7, 92.8, 93.1, 93.2, 93.3, 93.5]",
    ].join("\n");
    const zeroFrame = await mountRuntime({ height: 0, width: 0 }, { allowSameOrigin: true });
    const measuringFrame = await mountRuntime(
      { height: 240, width: 240 },
      { allowSameOrigin: true },
    );
    const fullFrame = await mountRuntime({ height: 500, width: 700 }, { allowSameOrigin: true });

    await render(zeroFrame, { revision: 1, source });
    await render(measuringFrame, { revision: 1, source });
    await render(fullFrame, { revision: 1, source });

    for (const frame of [zeroFrame, measuringFrame]) {
      frame.style.width = "700px";
      frame.style.height = "500px";
      const doc = frame.contentDocument;
      if (!doc) {
        throw new Error("Expected inspectable runtime document");
      }
      const svgRect = doc.querySelector("#diagram svg")?.getBoundingClientRect();
      const yTitleRect = doc.querySelector(".left-axis .title text")?.getBoundingClientRect();
      const yLabels = Array.from(doc.querySelectorAll(".left-axis .label text"));
      const xLabels = Array.from(doc.querySelectorAll(".bottom-axis .label text"));
      expect(svgRect).not.toBeUndefined();
      expect(yTitleRect).not.toBeUndefined();
      expect(yLabels.length).toBeGreaterThan(0);
      expect(xLabels.length).toBeGreaterThan(0);

      for (const label of yLabels) {
        expect(yTitleRect!.right).toBeLessThan(label.getBoundingClientRect().left);
      }
      for (const label of xLabels) {
        expect(label.getBoundingClientRect().bottom).toBeLessThanOrEqual(svgRect!.bottom);
      }
    }

    function axisOrigin(frame: HTMLIFrameElement): { leftAxisX: number; bottomAxisY: number } {
      const doc = frame.contentDocument;
      const leftPath = doc?.querySelector(".left-axis .axisl-line path")?.getAttribute("d") ?? "";
      const bottomPath =
        doc?.querySelector(".bottom-axis .axis-line path")?.getAttribute("d") ?? "";
      const leftMatch = leftPath.match(/^M\s+([\d.]+),/);
      const bottomMatch = bottomPath.match(/^M\s+[\d.]+,([\d.]+)/);
      if (!leftMatch || !bottomMatch) {
        throw new Error(`Unexpected axis paths: ${leftPath} | ${bottomPath}`);
      }
      return {
        leftAxisX: Number.parseFloat(leftMatch[1]),
        bottomAxisY: Number.parseFloat(bottomMatch[1]),
      };
    }

    const fullOrigin = axisOrigin(fullFrame);
    for (const candidate of [measuringFrame, zeroFrame]) {
      const origin = axisOrigin(candidate);
      expect(origin.leftAxisX).toBeCloseTo(fullOrigin.leftAxisX, 3);
      expect(origin.bottomAxisY).toBeCloseTo(fullOrigin.bottomAxisY, 3);
    }
  });

  /**
   * A gantt chart takes the width of the element Mermaid renders it in. Rendering inside the large
   * offscreen container must keep it as wide as the frame, which on native is the message column.
   */
  it("renders a gantt chart as wide as the frame the host gives it", async () => {
    const source = [
      "gantt",
      "  title Release plan",
      "  dateFormat YYYY-MM-DD",
      "  section Build",
      "  Design :a1, 2024-01-01, 10d",
      "  Implement :after a1, 20d",
    ].join("\n");
    const widths = [];
    for (const width of [240, 350, 900]) {
      const frame = await mountRuntime({ height: 240, width });
      widths.push(renderedSize(await render(frame, { revision: 1, source })).width);
    }

    expect(widths).toEqual([240, 350, 900]);
  });

  it("coalesces queued input and never reports an obsolete result", async () => {
    const frame = await mountRuntime();
    const obsoleteSource = `flowchart TD\n${Array.from({ length: 250 }, (_, index) => `A${index} --> A${index + 1}`).join("\n")}`;
    const currentSource = "flowchart TD\nCurrent --> Result";
    const obsoleteResponses: MermaidRuntimeMessage[] = [];
    function collect(event: MessageEvent): void {
      if (event.source !== frame.contentWindow) {
        return;
      }
      const message = parseMermaidRuntimeMessage(event.data);
      if (message && message.type !== "bridgeReady" && message.revision === 10) {
        obsoleteResponses.push(message);
      }
    }
    window.addEventListener("message", collect);
    frame.contentWindow?.postMessage(
      {
        type: "render",
        revision: 10,
        source: obsoleteSource,
        colorScheme: "dark",
        interactive: false,
      },
      "*",
    );
    const current = await render(frame, { revision: 11, source: currentSource });
    window.removeEventListener("message", collect);

    expect(current).toMatchObject({ type: "rendered", revision: 11, source: currentSource });
    expect(obsoleteResponses).toEqual([]);
  });
});
