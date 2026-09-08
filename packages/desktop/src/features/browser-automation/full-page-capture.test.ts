import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import {
  captureFullPage,
  FullPageCaptureUnsupportedError,
  type FullPageCaptureImage,
  type FullPageCaptureTarget,
} from "./full-page-capture.js";

function solidBitmap(width: number, height: number, value: number): Uint8Array {
  const bitmap = new Uint8Array(width * height * 4);
  bitmap.fill(value);
  return bitmap;
}

class FakeImage implements FullPageCaptureImage {
  public constructor(
    private readonly bitmap: Uint8Array,
    private readonly size: { width: number; height: number },
  ) {}

  public getSize(): { width: number; height: number } {
    return this.size;
  }

  public toBitmap(): Uint8Array {
    return this.bitmap;
  }

  public toPNG(): Uint8Array {
    return this.bitmap;
  }
}

interface HarnessOptions {
  contentSizes: { width: number; height: number }[];
  tiles: FullPageCaptureImage[];
  scrollPosition?: (x: number, y: number) => { x: number; y: number };
  afterPaint?: (position: { x: number; y: number }) => { x: number; y: number };
}

class FullPageCaptureHarness implements FullPageCaptureTarget {
  public readonly scripts: string[] = [];
  public readonly debugCommands: string[] = [];
  public invalidations = 0;
  public outputBitmap: Uint8Array | null = null;
  public outputSize: { width: number; height: number } | null = null;
  private captureIndex = 0;
  private metricsIndex = 0;
  private scroll = { x: 1, y: 1 };

  public constructor(private readonly options: HarnessOptions) {}

  public async executeJavaScript(code: string): Promise<unknown> {
    this.scripts.push(code);
    if (code.includes("viewportWidth: innerWidth")) {
      return {
        scrollX: 1,
        scrollY: 1,
        viewportWidth: 2,
        viewportHeight: 2,
      };
    }
    const scrollXMatch = code.match(/scrollingElement\.scrollLeft = (-?\d+(?:\.\d+)?)/);
    const scrollYMatch = code.match(/scrollingElement\.scrollTop = (-?\d+(?:\.\d+)?)/);
    if (scrollXMatch && scrollYMatch) {
      const requested = {
        x: Number(scrollXMatch[1]),
        y: Number(scrollYMatch[1]),
      };
      this.scroll = this.options.scrollPosition
        ? this.options.scrollPosition(requested.x, requested.y)
        : requested;
      return undefined;
    }
    if (code.includes("return { x: scrollingElement.scrollLeft")) {
      return this.scroll;
    }
    return undefined;
  }

  public invalidate(): void {
    this.invalidations += 1;
  }

  public async waitForPaint(): Promise<void> {
    if (this.options.afterPaint) {
      this.scroll = this.options.afterPaint(this.scroll);
    }
  }

  public async sendDebugCommand(command: string): Promise<unknown> {
    this.debugCommands.push(command);
    if (command === "Page.getLayoutMetrics") {
      const index = Math.min(this.metricsIndex, this.options.contentSizes.length - 1);
      this.metricsIndex += 1;
      return { cssContentSize: this.options.contentSizes[index] };
    }
    if (command === "Page.captureScreenshot") {
      return { data: `tile-${this.captureIndex++}` };
    }
    throw new Error(`Unexpected command: ${command}`);
  }

  public createImageFromPng(dataBase64: string): FullPageCaptureImage {
    const index = Number(dataBase64.replace("tile-", ""));
    const tile = this.options.tiles[index];
    if (!tile) {
      throw new Error(`Missing tile ${index}`);
    }
    return tile;
  }

  public createImageFromBitmap(
    bitmap: Uint8Array,
    size: { width: number; height: number },
  ): FullPageCaptureImage {
    this.outputBitmap = bitmap;
    this.outputSize = size;
    return new FakeImage(bitmap, size);
  }
}

class FakeStyleDeclaration {
  private readonly priorities = new Map<string, string>();
  private readonly values = new Map<string, string>();

  public constructor(initial: Record<string, string>) {
    for (const [property, value] of Object.entries(initial)) {
      this.values.set(property, value);
    }
  }

  public getPropertyValue(property: string): string {
    return this.values.get(property) ?? "";
  }

  public getPropertyPriority(property: string): string {
    return this.priorities.get(property) ?? "";
  }

  public setProperty(property: string, value: string, priority = ""): void {
    this.values.set(property, value);
    if (priority) {
      this.priorities.set(property, priority);
    } else {
      this.priorities.delete(property);
    }
  }

  public removeProperty(property: string): void {
    this.values.delete(property);
    this.priorities.delete(property);
  }
}

class FakePageElement {
  public isConnected = true;
  public readonly style = new FakeStyleDeclaration({ position: "sticky", top: "12px" });
}

class ScriptedPageCaptureHarness extends FullPageCaptureHarness {
  public readonly sticky = new FakePageElement();
  private readonly scriptContext: Record<string, unknown>;

  public constructor(options: HarnessOptions) {
    super(options);
    const scrollingElement = { scrollLeft: 0, scrollTop: 0 };
    this.scriptContext = {
      document: {
        scrollingElement,
        documentElement: {
          scrollLeft: 0,
          scrollTop: 0,
          appendChild: () => undefined,
        },
        createElement: () => ({ textContent: "", remove: () => undefined }),
        querySelectorAll: () => [this.sticky],
      },
      getComputedStyle: (element: unknown) => ({
        position: element === this.sticky ? "sticky" : "static",
      }),
    };
  }

  public override async executeJavaScript(code: string): Promise<unknown> {
    const scripted = await super.executeJavaScript(code);
    const isPageStateRead = code.includes("viewportWidth: innerWidth");
    const isScrollRead = code.includes("return { x: scrollingElement.scrollLeft");
    const isTileScrollWrite =
      code.includes("scrollingElement.scrollLeft =") &&
      !code.includes("restoreProperty(entry.element");
    if (isPageStateRead || isScrollRead || isTileScrollWrite) {
      return scripted;
    }
    return runInNewContext(code, this.scriptContext);
  }
}

function image(width: number, height: number, value: number): FakeImage {
  return new FakeImage(solidBitmap(width, height, value), { width, height });
}

describe("captureFullPage", () => {
  test("stitches successive viewport rows and restores temporary page state", async () => {
    const harness = new FullPageCaptureHarness({
      contentSizes: [
        { width: 2, height: 4 },
        { width: 2, height: 4 },
      ],
      tiles: [image(2, 2, 1), image(2, 2, 2)],
    });

    const captured = await captureFullPage(harness);

    expect(captured.getSize()).toEqual({ width: 2, height: 4 });
    expect(Array.from(captured.toBitmap())).toEqual([...Array(16).fill(1), ...Array(16).fill(2)]);
    expect(harness.invalidations).toBeGreaterThanOrEqual(2);
    expect(harness.scripts.some((script) => script.includes("position === 'fixed'"))).toBe(true);
    expect(harness.scripts.some((script) => script.includes("position', 'relative'"))).toBe(true);
    expect(harness.scripts.some((script) => script.includes("if (false)"))).toBe(true);
    const restoreScript = harness.scripts.at(-1) ?? "";
    expect(restoreScript).toContain("scrollingElement.scrollLeft = 1");
    expect(restoreScript).toContain("state.fixedElements");
    expect(restoreScript).toContain("state.stickyElements");
    expect(restoreScript).toContain("state.style.remove()");
  });

  test("restores inline styles on elements detached during capture", async () => {
    let sticky: FakePageElement | undefined;
    const harness = new ScriptedPageCaptureHarness({
      contentSizes: [{ width: 2, height: 2 }],
      tiles: [image(2, 2, 1)],
      afterPaint: (position) => {
        if (sticky) {
          sticky.isConnected = false;
        }
        return position;
      },
    });
    sticky = harness.sticky;

    await captureFullPage(harness);

    expect(harness.sticky.isConnected).toBe(false);
    expect(harness.sticky.style.getPropertyValue("position")).toBe("sticky");
    expect(harness.sticky.style.getPropertyValue("top")).toBe("12px");
  });

  test("crops the final tile when the browser clamps its scroll position", async () => {
    const finalBitmap = new Uint8Array([...Array(8).fill(3), ...Array(8).fill(4)]);
    const harness = new FullPageCaptureHarness({
      contentSizes: [
        { width: 2, height: 5 },
        { width: 2, height: 5 },
      ],
      tiles: [image(2, 2, 1), image(2, 2, 2), new FakeImage(finalBitmap, { width: 2, height: 2 })],
      scrollPosition: (x, y) => ({ x, y: Math.min(y, 3) }),
    });

    const captured = await captureFullPage(harness);

    expect(captured.getSize()).toEqual({ width: 2, height: 5 });
    expect(Array.from(captured.toBitmap().slice(-8))).toEqual(Array(8).fill(4));
  });

  test("rejects a page that asynchronously redirects the requested scroll", async () => {
    const harness = new FullPageCaptureHarness({
      contentSizes: [{ width: 2, height: 4 }],
      tiles: [image(2, 2, 1)],
      afterPaint: (position) => ({ x: position.x, y: position.y > 0 ? 0 : position.y }),
    });

    await expect(captureFullPage(harness)).rejects.toThrow(
      "stable scroll position for full-page capture",
    );

    expect(
      harness.debugCommands.filter((command) => command === "Page.captureScreenshot"),
    ).toHaveLength(1);
  });

  test("recaptures when scrolling expands the document", async () => {
    const harness = new FullPageCaptureHarness({
      contentSizes: [
        { width: 2, height: 4 },
        { width: 2, height: 6 },
        { width: 2, height: 6 },
      ],
      tiles: [image(2, 2, 1), image(2, 2, 2), image(2, 2, 3), image(2, 2, 4), image(2, 2, 5)],
    });

    const captured = await captureFullPage(harness);

    expect(captured.getSize()).toEqual({ width: 2, height: 6 });
    expect(Array.from(captured.toBitmap())).toEqual([
      ...Array(16).fill(3),
      ...Array(16).fill(4),
      ...Array(16).fill(5),
    ]);
  });

  test("rejects captures that exceed tile or bitmap limits", async () => {
    const tooManyTiles = new FullPageCaptureHarness({
      contentSizes: [{ width: 2, height: 258 }],
      tiles: [],
    });
    await expect(captureFullPage(tooManyTiles)).rejects.toBeInstanceOf(
      FullPageCaptureUnsupportedError,
    );

    const oversizedBitmap = new FullPageCaptureHarness({
      contentSizes: [{ width: 2, height: 2 }],
      tiles: [new FakeImage(new Uint8Array(), { width: 10_000, height: 10_000 })],
    });
    await expect(captureFullPage(oversizedBitmap)).rejects.toThrow("maximum is 128 MiB");
  });

  test("restores the page after a tile capture fails", async () => {
    const harness = new FullPageCaptureHarness({
      contentSizes: [{ width: 2, height: 2 }],
      tiles: [],
    });

    await expect(captureFullPage(harness)).rejects.toThrow("Missing tile 0");

    const restoreScript = harness.scripts.at(-1) ?? "";
    expect(restoreScript).toContain("scrollingElement.scrollLeft = 1");
    expect(restoreScript).toContain("state.style.remove()");
  });
});
