import { expect, type Locator, type Page } from "@playwright/test";

// How far on each side of a control's edge to look for its focus ring, in CSS pixels.
const EDGE_BAND_PX = 6;

export interface FocusRingSides {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Presses Tab until `target` holds keyboard focus, the way a keyboard user reaches it. */
export async function tabUntilFocused(page: Page, target: Locator, maxPresses = 12): Promise<void> {
  for (let press = 0; press < maxPresses; press += 1) {
    if (await target.evaluate((node) => node === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
  expect(await target.evaluate((node) => node.matches(":focus-visible"))).toBe(true);
}

async function edgeRegion(page: Page, target: Locator) {
  const box = await target.boundingBox();
  if (!box) throw new Error("Focus ring target has no layout box");
  const clip = {
    x: box.x - EDGE_BAND_PX,
    y: box.y - EDGE_BAND_PX,
    width: box.width + EDGE_BAND_PX * 2,
    height: box.height + EDGE_BAND_PX * 2,
  };
  const png = (await page.screenshot({ clip })).toString("base64");
  return { clip, png };
}

/**
 * For each straight edge of the focused `target`, the fraction of its middle half where the
 * ring colour reaches the screen within EDGE_BAND_PX of the edge. Reads the rendered pixels,
 * so a side that an ancestor clips scores 0.
 */
export async function focusRingSideCoverage(page: Page, target: Locator): Promise<FocusRingSides> {
  const ringColor = await target.evaluate((node) => getComputedStyle(node).outlineColor);
  const { clip, png } = await edgeRegion(page, target);
  return page.evaluate(
    async ({ screenshot, color, region, band }) => {
      const image = await createImageBitmap(
        await (await fetch(`data:image/png;base64,${screenshot}`)).blob(),
      );
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);
      const scale = image.width / region.width;
      const [r, g, b] = color.match(/\d+/g)!.map(Number);
      const isRing = (x: number, y: number) => {
        const i = (Math.round(y) * image.width + Math.round(x)) * 4;
        return Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b) < 60;
      };
      const bandPx = Math.ceil(band * scale * 2);
      const width = image.width;
      const height = image.height;
      // Fraction of positions along an edge where crossing the band meets ring colour.
      const coverage = (positions: number[], crossesRing: (at: number) => boolean) =>
        positions.filter(crossesRing).length / positions.length;
      const span = (from: number, to: number) => {
        const values: number[] = [];
        for (let at = Math.ceil(from); at < Math.floor(to); at += 1) values.push(at);
        return values;
      };
      const across = (from: number, to: number, hit: (offset: number) => boolean) => {
        for (let offset = from; offset < to; offset += 1) if (hit(offset)) return true;
        return false;
      };
      const columns = span(width * 0.25, width * 0.75);
      const rows = span(height * 0.25, height * 0.75);
      return {
        top: coverage(columns, (x) => across(0, bandPx, (y) => isRing(x, y))),
        bottom: coverage(columns, (x) => across(height - bandPx, height, (y) => isRing(x, y))),
        left: coverage(rows, (y) => across(0, bandPx, (x) => isRing(x, y))),
        right: coverage(rows, (y) => across(width - bandPx, width, (x) => isRing(x, y))),
      };
    },
    { screenshot: png, color: ringColor, region: clip, band: EDGE_BAND_PX },
  );
}

/**
 * How many pixels in and around `target` visibly change when `focus` moves keyboard focus onto
 * it. Reads the rendered pixels, so a ring painted in the control's own fill colour counts as no
 * change.
 */
export async function focusedPixelChange(
  page: Page,
  target: Locator,
  focus: () => Promise<void>,
): Promise<{ changed: number; perimeter: number }> {
  const before = await edgeRegion(page, target);
  await focus();
  const after = await page.screenshot({ clip: before.clip });
  const box = await target.boundingBox();
  if (!box) throw new Error("Focus ring target has no layout box");
  const changed = await page.evaluate(
    async ({ beforePng, afterPng }) => {
      const read = async (png: string) => {
        const image = await createImageBitmap(
          await (await fetch(`data:image/png;base64,${png}`)).blob(),
        );
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      };
      const [a, b] = await Promise.all([read(beforePng), read(afterPng)]);
      let count = 0;
      for (let i = 0; i < a.length; i += 4) {
        const distance =
          Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        if (distance > 100) count += 1;
      }
      return count;
    },
    { beforePng: before.png, afterPng: after.toString("base64") },
  );
  return { changed, perimeter: Math.round(2 * (box.width + box.height)) };
}
