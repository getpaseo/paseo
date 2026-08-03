import { test, expect } from "../support/fixtures";
import { mermaidWebViewHtml } from "../../src/mermaid/webview/html";

const palette = {
  background: "#ffffff",
  border: "#d4d4d8",
  foreground: "#18181b",
  mutedForeground: "#71717a",
  primary: "#20744a",
  primaryForeground: "#ffffff",
  surface: "#f4f4f5",
};

test("renders and controls the bundled native Mermaid document", async ({ page }) => {
  await page.goto("about:blank");
  await page.evaluate(() => {
    Reflect.set(window, "__mermaidMessages", []);
    Reflect.set(window, "ReactNativeWebView", {
      postMessage(serialized: string) {
        const messages = Reflect.get(window, "__mermaidMessages");
        if (Array.isArray(messages)) {
          messages.push(JSON.parse(serialized));
        }
      },
    });
  });
  await page.setContent(mermaidWebViewHtml);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const messages = Reflect.get(window, "__mermaidMessages");
        if (!Array.isArray(messages)) return false;
        for (const message of messages) {
          if (message.type === "ready") return true;
        }
        return false;
      }),
    )
    .toBe(true);

  await page.evaluate(
    ({ diagramCode, diagramPalette }) => {
      const receive = Reflect.get(window, "__PASEO_MERMAID_RECEIVE__");
      if (typeof receive !== "function") {
        throw new Error("Mermaid bridge is unavailable");
      }
      receive(
        JSON.stringify({
          type: "render",
          code: diagramCode,
          palette: diagramPalette,
          panBehavior: "rubber-band",
        }),
      );
    },
    {
      diagramCode: "flowchart LR\n  Native --> WebView\n  WebView --> Mermaid",
      diagramPalette: palette,
    },
  );

  await expect(page.locator("#mermaid-canvas svg")).toBeVisible();
  const initialTransform = await page
    .locator("#mermaid-canvas")
    .evaluate((element) => getComputedStyle(element).transform);

  const zoomTransitionDuration = await page.evaluate(() => {
    const receive = Reflect.get(window, "__PASEO_MERMAID_RECEIVE__");
    if (typeof receive === "function") {
      receive(JSON.stringify({ type: "zoomIn" }));
    }
    const canvas = document.querySelector<HTMLElement>("#mermaid-canvas");
    return canvas?.style.transitionDuration;
  });
  expect(zoomTransitionDuration).toBe("180ms");

  await expect
    .poll(() =>
      page.locator("#mermaid-canvas").evaluate((element) => getComputedStyle(element).transform),
    )
    .not.toBe(initialTransform);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const messages = Reflect.get(window, "__mermaidMessages");
        if (!Array.isArray(messages)) return false;
        for (const message of messages) {
          if (message.type === "camera" && message.canZoomOut === true) return true;
        }
        return false;
      }),
    )
    .toBe(true);

  await expect
    .poll(() =>
      page
        .locator("#mermaid-canvas")
        .evaluate((element) => (element as HTMLElement).style.transitionDuration),
    )
    .toBe("0s");
  const viewportBounds = await page.locator("#mermaid-viewport").boundingBox();
  if (!viewportBounds) {
    throw new Error("Mermaid viewport has no bounds");
  }
  const dragStart = {
    x: viewportBounds.x + viewportBounds.width / 2,
    y: viewportBounds.y + viewportBounds.height / 2,
  };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + viewportBounds.width, dragStart.y);

  const overscrolledX = await page.locator("#mermaid-canvas").evaluate((element) => {
    return new DOMMatrix((element as HTMLElement).style.transform).m41;
  });
  expect(overscrolledX).toBeGreaterThan(0);

  await page.mouse.up();
  const releasedX = await page.locator("#mermaid-canvas").evaluate((element) => {
    return new DOMMatrix((element as HTMLElement).style.transform).m41;
  });
  await expect
    .poll(() =>
      page.locator("#mermaid-canvas").evaluate((element) => {
        return new DOMMatrix((element as HTMLElement).style.transform).m41;
      }),
    )
    .not.toBe(releasedX);
  await expect
    .poll(() =>
      page.locator("#mermaid-canvas").evaluate((element) => {
        return Math.abs(new DOMMatrix((element as HTMLElement).style.transform).m41 - 24);
      }),
    )
    .toBeLessThan(0.5);

  const leftDragStart = {
    x: viewportBounds.x + viewportBounds.width * 0.9,
    y: dragStart.y,
  };
  await page.mouse.move(leftDragStart.x, leftDragStart.y);
  await page.mouse.down();
  await page.mouse.move(viewportBounds.x + viewportBounds.width * 0.1, leftDragStart.y);
  const leftBoundary = await page.locator("#mermaid-canvas").evaluate((element) => {
    const canvas = element as HTMLElement;
    const viewport = canvas.parentElement;
    if (!viewport) throw new Error("Mermaid canvas has no viewport");
    const transform = new DOMMatrix(canvas.style.transform);
    return viewport.clientWidth - canvas.clientWidth * transform.a - 24;
  });
  const leftOverscroll = await page.locator("#mermaid-canvas").evaluate((element) => {
    return new DOMMatrix((element as HTMLElement).style.transform).m41;
  });
  expect(leftOverscroll).toBeLessThan(leftBoundary);

  await page.mouse.up();
  await expect
    .poll(() =>
      page.locator("#mermaid-canvas").evaluate((element) => {
        const canvas = element as HTMLElement;
        const viewport = canvas.parentElement;
        if (!viewport) throw new Error("Mermaid canvas has no viewport");
        const transform = new DOMMatrix(canvas.style.transform);
        const minimumX = viewport.clientWidth - canvas.clientWidth * transform.a - 24;
        return Math.abs(transform.m41 - minimumX);
      }),
    )
    .toBeLessThan(1);
});
