import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z, type ZodType } from "zod";

export interface FullPageCaptureImage {
  getSize(): { width: number; height: number };
  toBitmap(): Uint8Array;
  toPNG(): Uint8Array;
}

export interface FullPageCaptureTarget {
  executeJavaScript(code: string): Promise<unknown>;
  invalidate(): void;
  waitForPaint?(signal?: AbortSignal): Promise<void>;
  sendDebugCommand(command: string, params?: Record<string, unknown>): Promise<unknown>;
  createImageFromPng(dataBase64: string): FullPageCaptureImage;
  createImageFromBitmap(
    bitmap: Uint8Array,
    size: { width: number; height: number },
  ): FullPageCaptureImage;
}

export interface FullPageCaptureOptions {
  signal?: AbortSignal;
}

const FiniteNumberSchema = z.number().finite();
const PositiveDimensionSchema = FiniteNumberSchema.positive().transform(Math.ceil);
const PageCaptureStateSchema = z.object({
  scrollX: FiniteNumberSchema,
  scrollY: FiniteNumberSchema,
  viewportWidth: PositiveDimensionSchema,
  viewportHeight: PositiveDimensionSchema,
});
const ScrollPositionSchema = z.object({
  x: FiniteNumberSchema,
  y: FiniteNumberSchema,
});
const PageContentSizeSchema = z.object({
  width: PositiveDimensionSchema,
  height: PositiveDimensionSchema,
});
const LayoutMetricsSchema = z.object({
  cssContentSize: PageContentSizeSchema.optional(),
  contentSize: PageContentSizeSchema.optional(),
});
const ScreenshotResultSchema = z.object({ data: z.string().min(1) });

type PageCaptureState = z.output<typeof PageCaptureStateSchema>;
type PageContentSize = z.output<typeof PageContentSizeSchema>;

interface PixelScale {
  x: number;
  y: number;
}

interface CapturedBitmap {
  bitmap: Uint8Array;
  size: { width: number; height: number };
  content: PageContentSize;
}

const MAX_FULL_PAGE_BITMAP_BYTES = 128 * 1024 * 1024;
const MAX_FULL_PAGE_TILES = 128;
const MAX_LAYOUT_PASSES = 3;
const MAX_TILE_SCROLL_ATTEMPTS = 3;
const SCROLL_EPSILON = 1;

export class FullPageCaptureError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FullPageCaptureError";
  }
}

export class FullPageCaptureUnsupportedError extends FullPageCaptureError {
  public constructor(message: string) {
    super(message);
    this.name = "FullPageCaptureUnsupportedError";
  }
}

function parseBoundary<T>(schema: ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new FullPageCaptureError(`${label} returned invalid data`);
  }
  return parsed.data;
}

function readPageCaptureState(value: unknown): PageCaptureState {
  return parseBoundary(PageCaptureStateSchema, value, "Browser page state");
}

function readScrollPosition(value: unknown): { x: number; y: number } {
  return parseBoundary(ScrollPositionSchema, value, "Browser scroll position");
}

function readContentSize(value: unknown): PageContentSize {
  const metrics = parseBoundary(LayoutMetricsSchema, value, "Page.getLayoutMetrics");
  const content = metrics.cssContentSize ?? metrics.contentSize;
  if (!content) {
    throw new FullPageCaptureError("Page.getLayoutMetrics returned no content size");
  }
  return content;
}

function readScreenshotData(value: unknown): string {
  return parseBoundary(ScreenshotResultSchema, value, "Page.captureScreenshot").data;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw new FullPageCaptureError("Full-page capture was aborted");
}

function tileOrigins(
  content: PageContentSize,
  viewport: { width: number; height: number },
): { x: number[]; y: number[] } {
  const columns = Math.ceil(content.width / viewport.width);
  const rows = Math.ceil(content.height / viewport.height);
  const tileCount = columns * rows;
  if (!Number.isSafeInteger(tileCount) || tileCount > MAX_FULL_PAGE_TILES) {
    throw new FullPageCaptureUnsupportedError(
      `Full-page screenshot requires ${tileCount} tiles; the maximum is ${MAX_FULL_PAGE_TILES}.`,
    );
  }
  return {
    x: Array.from({ length: columns }, (_, index) => index * viewport.width),
    y: Array.from({ length: rows }, (_, index) => index * viewport.height),
  };
}

function createOutputBitmap(
  content: PageContentSize,
  scale: PixelScale,
): {
  bitmap: Uint8Array;
  size: { width: number; height: number };
} {
  const size = {
    width: Math.round(content.width * scale.x),
    height: Math.round(content.height * scale.y),
  };
  const byteLength = size.width * size.height * 4;
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength <= 0 ||
    byteLength > MAX_FULL_PAGE_BITMAP_BYTES
  ) {
    throw new FullPageCaptureUnsupportedError(
      `Full-page screenshot bitmap requires ${Math.ceil(byteLength / 1024 / 1024)} MiB; the maximum is ${MAX_FULL_PAGE_BITMAP_BYTES / 1024 / 1024} MiB.`,
    );
  }
  return { bitmap: new Uint8Array(byteLength), size };
}

function copyTile(input: {
  output: Uint8Array;
  outputWidth: number;
  content: PageContentSize;
  viewport: { width: number; height: number };
  target: { x: number; y: number };
  actualScroll: { x: number; y: number };
  tile: FullPageCaptureImage;
  scale: PixelScale;
}): void {
  const tileSize = input.tile.getSize();
  const targetLeft = Math.round(input.target.x * input.scale.x);
  const targetTop = Math.round(input.target.y * input.scale.y);
  const targetRight = Math.round(
    Math.min(input.target.x + input.viewport.width, input.content.width) * input.scale.x,
  );
  const targetBottom = Math.round(
    Math.min(input.target.y + input.viewport.height, input.content.height) * input.scale.y,
  );
  const copyWidth = targetRight - targetLeft;
  const copyHeight = targetBottom - targetTop;
  const sourceLeft = Math.round((input.target.x - input.actualScroll.x) * input.scale.x);
  const sourceTop = Math.round((input.target.y - input.actualScroll.y) * input.scale.y);
  if (
    sourceLeft < 0 ||
    sourceTop < 0 ||
    sourceLeft + copyWidth > tileSize.width ||
    sourceTop + copyHeight > tileSize.height
  ) {
    throw new FullPageCaptureUnsupportedError(
      "The page prevented the requested full-page scroll position.",
    );
  }

  const bitmap = input.tile.toBitmap();
  if (bitmap.length < tileSize.width * tileSize.height * 4) {
    throw new FullPageCaptureError("Full-page tile returned an incomplete bitmap");
  }
  for (let row = 0; row < copyHeight; row += 1) {
    const sourceOffset = ((sourceTop + row) * tileSize.width + sourceLeft) * 4;
    const targetOffset = ((targetTop + row) * input.outputWidth + targetLeft) * 4;
    input.output.set(bitmap.subarray(sourceOffset, sourceOffset + copyWidth * 4), targetOffset);
  }
}

async function waitForGuestPaint(
  target: FullPageCaptureTarget,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  target.invalidate();
  try {
    if (target.waitForPaint) {
      await target.waitForPaint(signal);
    } else {
      await delay(100, undefined, signal ? { signal } : undefined);
    }
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
  throwIfAborted(signal);
}

async function setGuestScroll(
  target: FullPageCaptureTarget,
  position: { x: number; y: number },
): Promise<void> {
  await target.executeJavaScript(`(() => {
    const scrollingElement = document.scrollingElement ?? document.documentElement;
    scrollingElement.scrollLeft = ${position.x};
    scrollingElement.scrollTop = ${position.y};
  })()`);
}

async function readGuestScroll(target: FullPageCaptureTarget): Promise<{ x: number; y: number }> {
  return readScrollPosition(
    await target.executeJavaScript(`(() => {
      const scrollingElement = document.scrollingElement ?? document.documentElement;
      return { x: scrollingElement.scrollLeft, y: scrollingElement.scrollTop };
    })()`),
  );
}

async function setFixedElementsVisible(
  target: FullPageCaptureTarget,
  captureToken: string,
  visible: boolean,
): Promise<void> {
  await target.executeJavaScript(`(() => {
    const state = globalThis[${JSON.stringify(captureToken)}];
    if (!state) return;
    for (const entry of state.fixedElements) {
      if (!entry.element.isConnected) continue;
      if (${visible}) {
        if (entry.visibility.value) {
          entry.element.style.setProperty('visibility', entry.visibility.value, entry.visibility.priority);
        } else {
          entry.element.style.removeProperty('visibility');
        }
      } else {
        entry.element.style.setProperty('visibility', 'hidden', 'important');
      }
    }
  })()`);
}

function scrollCoversTarget(input: {
  actual: { x: number; y: number };
  target: { x: number; y: number };
  viewport: { width: number; height: number };
  content: PageContentSize;
}): boolean {
  const targetRight = Math.min(input.target.x + input.viewport.width, input.content.width);
  const targetBottom = Math.min(input.target.y + input.viewport.height, input.content.height);
  return (
    input.actual.x <= input.target.x + SCROLL_EPSILON &&
    input.actual.y <= input.target.y + SCROLL_EPSILON &&
    input.actual.x + input.viewport.width >= targetRight - SCROLL_EPSILON &&
    input.actual.y + input.viewport.height >= targetBottom - SCROLL_EPSILON
  );
}

function sameScrollPosition(
  first: { x: number; y: number },
  second: { x: number; y: number },
): boolean {
  return (
    Math.abs(first.x - second.x) <= SCROLL_EPSILON && Math.abs(first.y - second.y) <= SCROLL_EPSILON
  );
}

async function captureViewportTile(input: {
  target: FullPageCaptureTarget;
  captureToken: string;
  content: PageContentSize;
  viewport: { width: number; height: number };
  position: { x: number; y: number };
  signal?: AbortSignal;
}): Promise<{ image: FullPageCaptureImage; actualScroll: { x: number; y: number } }> {
  for (let attempt = 0; attempt < MAX_TILE_SCROLL_ATTEMPTS; attempt += 1) {
    throwIfAborted(input.signal);
    await setFixedElementsVisible(
      input.target,
      input.captureToken,
      input.position.x === 0 && input.position.y === 0,
    );
    throwIfAborted(input.signal);
    await setGuestScroll(input.target, input.position);
    await waitForGuestPaint(input.target, input.signal);
    const actualScroll = await readGuestScroll(input.target);
    if (
      !scrollCoversTarget({
        actual: actualScroll,
        target: input.position,
        viewport: input.viewport,
        content: input.content,
      })
    ) {
      continue;
    }

    input.target.invalidate();
    const dataBase64 = readScreenshotData(
      await input.target.sendDebugCommand("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      }),
    );
    throwIfAborted(input.signal);
    const scrollAfterCapture = await readGuestScroll(input.target);
    if (!sameScrollPosition(actualScroll, scrollAfterCapture)) {
      continue;
    }
    return {
      image: input.target.createImageFromPng(dataBase64),
      actualScroll,
    };
  }

  throw new FullPageCaptureUnsupportedError(
    "The page did not remain at a stable scroll position for full-page capture.",
  );
}

async function captureTiles(input: {
  target: FullPageCaptureTarget;
  captureToken: string;
  content: PageContentSize;
  viewport: { width: number; height: number };
  signal?: AbortSignal;
}): Promise<CapturedBitmap> {
  const origins = tileOrigins(input.content, input.viewport);
  let output: Uint8Array | null = null;
  let outputSize = { width: 0, height: 0 };
  let scale: PixelScale | null = null;

  for (const y of origins.y) {
    for (const x of origins.x) {
      const tileCapture = await captureViewportTile({
        ...input,
        position: { x, y },
      });
      const tileSize = tileCapture.image.getSize();
      if (!scale) {
        scale = {
          x: tileSize.width / input.viewport.width,
          y: tileSize.height / input.viewport.height,
        };
        if (
          !Number.isFinite(scale.x) ||
          !Number.isFinite(scale.y) ||
          scale.x <= 0 ||
          scale.y <= 0 ||
          Math.abs(scale.x - scale.y) > 0.01
        ) {
          throw new FullPageCaptureError("Full-page tile returned an invalid pixel scale");
        }
        const created = createOutputBitmap(input.content, scale);
        output = created.bitmap;
        outputSize = created.size;
      }
      if (!output || !scale) {
        throw new FullPageCaptureError("Full-page capture did not initialize its bitmap");
      }
      if (
        tileSize.width !== Math.round(input.viewport.width * scale.x) ||
        tileSize.height !== Math.round(input.viewport.height * scale.y)
      ) {
        throw new FullPageCaptureError("Full-page tile dimensions changed during capture");
      }
      copyTile({
        output,
        outputWidth: outputSize.width,
        content: input.content,
        viewport: input.viewport,
        target: { x, y },
        actualScroll: tileCapture.actualScroll,
        tile: tileCapture.image,
        scale,
      });
    }
  }

  if (!output) {
    throw new FullPageCaptureError("Full-page capture produced no tiles");
  }
  return { bitmap: output, size: outputSize, content: input.content };
}

function sameContentSize(first: PageContentSize, second: PageContentSize): boolean {
  return first.width === second.width && first.height === second.height;
}

async function captureStableLayout(input: {
  target: FullPageCaptureTarget;
  captureToken: string;
  viewport: { width: number; height: number };
  signal?: AbortSignal;
}): Promise<CapturedBitmap> {
  let content = readContentSize(await input.target.sendDebugCommand("Page.getLayoutMetrics"));
  for (let pass = 0; pass < MAX_LAYOUT_PASSES; pass += 1) {
    throwIfAborted(input.signal);
    const capture = await captureTiles({ ...input, content });
    await waitForGuestPaint(input.target, input.signal);
    const nextContent = readContentSize(
      await input.target.sendDebugCommand("Page.getLayoutMetrics"),
    );
    if (sameContentSize(content, nextContent)) {
      return capture;
    }
    content = nextContent;
  }
  throw new FullPageCaptureUnsupportedError(
    "The page layout kept changing during full-page capture.",
  );
}

export async function captureFullPage(
  target: FullPageCaptureTarget,
  options: FullPageCaptureOptions = {},
): Promise<FullPageCaptureImage> {
  throwIfAborted(options.signal);
  const captureToken = `__paseoFullPageCapture_${randomUUID().replaceAll("-", "")}`;
  const originalState = readPageCaptureState(
    await target.executeJavaScript(`({
      scrollX,
      scrollY,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight
    })`),
  );
  let image: FullPageCaptureImage | undefined;
  let captureError: unknown;
  let captureFailed = false;

  try {
    throwIfAborted(options.signal);
    await target.executeJavaScript(`(() => {
      const style = document.createElement('style');
      style.textContent = [
        ':root { overflow: auto !important; overflow-anchor: none !important; scroll-behavior: auto !important; scroll-snap-type: none !important; }',
        'body { overflow: visible !important; overflow-anchor: none !important; scroll-behavior: auto !important; scroll-snap-type: none !important; }',
        '::-webkit-scrollbar { display: none !important; }'
      ].join(' ');
      document.documentElement.appendChild(style);
      const state = { style, fixedElements: [], stickyElements: [] };
      globalThis[${JSON.stringify(captureToken)}] = state;
      const rememberProperty = (element, property) => ({
        property,
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property)
      });
      for (const element of document.querySelectorAll('*')) {
        const position = getComputedStyle(element).position;
        if (position === 'fixed') {
          state.fixedElements.push({
            element,
            visibility: rememberProperty(element, 'visibility')
          });
        } else if (position === 'sticky' || position === '-webkit-sticky') {
          const properties = ['position', 'top', 'right', 'bottom', 'left'].map((property) =>
            rememberProperty(element, property)
          );
          state.stickyElements.push({ element, properties });
          element.style.setProperty('position', 'relative', 'important');
          element.style.setProperty('top', 'auto', 'important');
          element.style.setProperty('right', 'auto', 'important');
          element.style.setProperty('bottom', 'auto', 'important');
          element.style.setProperty('left', 'auto', 'important');
        }
      }
    })()`);
    await waitForGuestPaint(target, options.signal);

    const capture = await captureStableLayout({
      target,
      captureToken,
      viewport: {
        width: originalState.viewportWidth,
        height: originalState.viewportHeight,
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    throwIfAborted(options.signal);
    image = target.createImageFromBitmap(capture.bitmap, capture.size);
  } catch (error) {
    captureError = error;
    captureFailed = true;
  }

  let cleanupError: unknown;
  let cleanupFailed = false;
  try {
    await target.executeJavaScript(`(() => {
        const state = globalThis[${JSON.stringify(captureToken)}];
        if (!state) return false;
        const restoreProperty = (element, snapshot) => {
          if (snapshot.value) {
            element.style.setProperty(snapshot.property, snapshot.value, snapshot.priority);
          } else {
            element.style.removeProperty(snapshot.property);
          }
        };
        const scrollingElement = document.scrollingElement ?? document.documentElement;
        scrollingElement.scrollLeft = ${originalState.scrollX};
        scrollingElement.scrollTop = ${originalState.scrollY};
        for (const entry of state.fixedElements) {
          restoreProperty(entry.element, entry.visibility);
        }
        for (const entry of state.stickyElements) {
          for (const property of entry.properties) restoreProperty(entry.element, property);
        }
        state.style.remove();
        delete globalThis[${JSON.stringify(captureToken)}];
        return true;
      })()`);
    await waitForGuestPaint(target, undefined);
  } catch (error) {
    cleanupError = error;
    cleanupFailed = true;
  }

  if (captureFailed) {
    throw captureError;
  }
  if (cleanupFailed) {
    throw cleanupError;
  }
  if (!image) {
    throw new FullPageCaptureError("Full-page capture returned no image");
  }
  return image;
}
