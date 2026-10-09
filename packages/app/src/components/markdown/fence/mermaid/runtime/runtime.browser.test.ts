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
  { fractionalMeasurement = false }: { fractionalMeasurement?: boolean } = {},
): Promise<HTMLIFrameElement> {
  const frame = document.createElement("iframe");
  frame.sandbox.add("allow-scripts");
  if (size) {
    frame.style.width = `${size.width}px`;
    frame.style.height = `${size.height}px`;
  }
  const ready = waitForRuntimeMessage(frame, (message) => message.type === "bridgeReady");
  frame.srcdoc = fractionalMeasurement
    ? withFractionalMeasurement(mermaidRuntimeHtml)
    : mermaidRuntimeHtml;
  document.body.append(frame);
  mountedFrames.push(frame);
  await ready;
  return frame;
}

/**
 * Emulate Chrome/Blink on a fractional device pixel ratio, where
 * `getBoundingClientRect()` returns a width a fraction of a pixel off the
 * integer `max-width` Mermaid sets. Mermaid's HTML-label wrap check is an exact
 * float comparison (`bbox.width === width`), so the offset makes a long label
 * skip the wrap branch and clip. Appended after the runtime so it patches the
 * iframe's own realm, not this document.
 */
function withFractionalMeasurement(html: string): string {
  const patch = `<script>(function () {
    var original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      var rect = original.call(this);
      if (this.tagName === "DIV") {
        var offset = Object.create(Object.getPrototypeOf(rect));
        Object.defineProperties(offset, {
          width: { value: rect.width - 0.5 },
          height: { value: rect.height },
          top: { value: rect.top }, left: { value: rect.left },
          right: { value: rect.right }, bottom: { value: rect.bottom },
          x: { value: rect.x }, y: { value: rect.y }
        });
        return offset;
      }
      return rect;
    };
  })();<\/script>`;
  return html + patch;
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
   * Regression for mermaid-js/mermaid#7794: on a fractional device pixel ratio
   * Chrome/Blink measures the label a fraction of a pixel off the configured
   * width, so Mermaid's exact `bbox.width === width` wrap check fails and a long
   * label clips instead of wrapping. The fix tolerates the rounding error.
   */
  it("wraps a long flowchart label when the measured width is fractional", async () => {
    const frame = await mountRuntime(undefined, { fractionalMeasurement: true });
    const shortSource = "flowchart TD\n  A[short] --> B[also short]";
    const longSource =
      "flowchart TD\n  A[This is a very long node label that should wrap onto multiple lines instead of being clipped] --> B[also short]";

    const short = renderedSize(await render(frame, { revision: 1, source: shortSource }));
    const long = renderedSize(await render(frame, { revision: 2, source: longSource }));

    // One line fits within the wrapping width; the other must wrap onto more.
    expect(long.height).toBeGreaterThan(short.height);
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
