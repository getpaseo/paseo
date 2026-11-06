import { expect, type Page } from "@playwright/test";

/**
 * The composer toolbar collapses its controls by measured width. A collapsed
 * frame is observable from the DOM: the mode trigger drops its label and
 * shrinks to the icon-only box, so a visible trigger with no text is a
 * collapsed paint.
 */
interface ToolbarFrame {
  atMs: number;
  labels: string[];
}

declare global {
  interface Window {
    __composerToolbarFrames?: ToolbarFrame[];
    __composerToolbarStop?: () => void;
  }
}

/** Records every painted frame's visible mode-trigger labels until stopped. */
export async function recordComposerToolbarFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frames: ToolbarFrame[] = [];
    window.__composerToolbarFrames = frames;
    const start = performance.now();
    let running = true;
    const tick = () => {
      if (!running) return;
      const labels = Array.from(document.querySelectorAll('[data-testid="mode-control"]'))
        .filter((node) => node.getClientRects().length > 0)
        .map((node) => (node.textContent ?? "").trim());
      frames.push({ atMs: Math.round(performance.now() - start), labels });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__composerToolbarStop = () => {
      running = false;
    };
  });
}

async function readComposerToolbarFrames(page: Page): Promise<ToolbarFrame[]> {
  return page.evaluate(() => {
    window.__composerToolbarStop?.();
    return window.__composerToolbarFrames ?? [];
  });
}

export async function expectNoCollapsedComposerToolbarFrame(page: Page): Promise<void> {
  const frames = await readComposerToolbarFrames(page);
  expect(frames.length).toBeGreaterThan(0);
  const collapsed = frames.filter((frame) => frame.labels.some((label) => label === ""));
  expect(collapsed, `collapsed toolbar frames: ${JSON.stringify(collapsed)}`).toEqual([]);
}

/** What the folded model control's labels show, read from the DOM. */
export interface ModelTriggerLabelState {
  thinkingShown: boolean;
  modelShown: boolean;
  modelText: string;
  modelTruncated: boolean;
}

declare global {
  interface Window {
    __modelTriggerFrames?: ModelTriggerLabelState[];
  }
}

function readModelTriggerLabelStateInPage(): ModelTriggerLabelState {
  const visible = (node: Element) => node.getClientRects().length > 0;
  const model = Array.from(
    document.querySelectorAll('[data-testid="combined-model-selector-model-label"]'),
  ).find(visible);
  const thinking = Array.from(
    document.querySelectorAll('[data-testid="combined-model-selector-thinking-label"]'),
  ).find(visible);
  const shown = (node: Element | null): boolean => {
    for (let current = node; current; current = current.parentElement) {
      if (Number(getComputedStyle(current).opacity) === 0) return false;
    }
    return true;
  };
  const modelShown = model !== undefined && shown(model);
  const modelText = model?.textContent ?? "";
  return {
    modelShown,
    modelText,
    thinkingShown: modelShown && thinking !== undefined,
    modelTruncated:
      model !== undefined && (modelText.endsWith("…") || model.scrollWidth > model.clientWidth),
  };
}

/** Records the folded model control's labels on every painted frame from page load. */
export async function recordModelTriggerFramesFromLoad(page: Page): Promise<void> {
  await page.addInitScript(`(() => {
    const read = ${readModelTriggerLabelStateInPage.toString()};
    const frames = [];
    window.__modelTriggerFrames = frames;
    const tick = () => {
      frames.push(read());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
}

/** The model control's labels once two reads 100ms apart agree. */
export async function readSettledModelTriggerLabels(page: Page): Promise<ModelTriggerLabelState> {
  let previous = await page.evaluate(readModelTriggerLabelStateInPage);
  for (;;) {
    await page.waitForTimeout(100);
    const next = await page.evaluate(readModelTriggerLabelStateInPage);
    if (JSON.stringify(next) === JSON.stringify(previous)) return next;
    previous = next;
  }
}

/** No frame recorded so far painted a truncated model label beside the thinking label. */
export async function expectNoFrameTruncatesModelBesideThinking(page: Page): Promise<void> {
  const frames = await page.evaluate(() => window.__modelTriggerFrames ?? []);
  expect(frames.some((frame) => frame.modelShown)).toBe(true);
  const wrong = frames
    .map((frame, index) => ({ ...frame, index }))
    .filter((frame) => frame.thinkingShown && frame.modelTruncated);
  expect(wrong, `of ${frames.length} frames`).toEqual([]);
}

/** The composer's text column edges and its toolbar's outermost ink, in CSS pixels. */
export interface ComposerToolbarRails {
  textLeft: number;
  textRight: number;
  inkLeft: number;
  inkRight: number;
}

/**
 * Reads where the toolbar's ink starts and ends against the text column. A control's ink is
 * its filled disc when it has one, otherwise its glyph's stroked geometry; the slot around
 * it is invisible and does not count.
 */
export async function readComposerToolbarRails(page: Page): Promise<ComposerToolbarRails> {
  const root = page.locator('[data-testid="message-input-root"]:visible').first();
  return root.evaluate((element) => {
    const textarea = element.querySelector("textarea");
    if (!textarea) throw new Error("composer has no text input");
    // The text column is inset equally from both sides of the composer. The text input itself
    // stops short on the right to leave room for the focus hint, so mirror its left inset.
    const composerRect = element.getBoundingClientRect();
    const textLeft =
      textarea.getBoundingClientRect().left +
      Number.parseFloat(getComputedStyle(textarea).paddingLeft);
    const textRight = composerRect.right - (textLeft - composerRect.left);

    const isFilled = (node: Element) => {
      const color = getComputedStyle(node).backgroundColor;
      return color !== "" && color !== "transparent" && !/rgba\(.*,\s*0\)$/.test(color);
    };
    const glyphInk = (svg: SVGSVGElement) => {
      let left = Number.POSITIVE_INFINITY;
      let right = Number.NEGATIVE_INFINITY;
      for (const shape of Array.from(
        svg.querySelectorAll<SVGGraphicsElement>("path, circle, rect, line, polyline"),
      )) {
        const matrix = shape.getScreenCTM();
        if (!matrix) continue;
        const box = shape.getBBox();
        const stroke = Number.parseFloat(getComputedStyle(shape).strokeWidth || "0");
        left = Math.min(left, matrix.a * (box.x - stroke / 2) + matrix.e);
        right = Math.max(right, matrix.a * (box.x + box.width + stroke / 2) + matrix.e);
      }
      return { left, right };
    };

    const band = composerRect.bottom - 64;
    let inkLeft = Number.POSITIVE_INFINITY;
    let inkRight = Number.NEGATIVE_INFINITY;
    for (const control of Array.from(element.querySelectorAll('[role="button"]'))) {
      const rect = control.getBoundingClientRect();
      if (rect.width === 0 || rect.top < band) continue;
      const disc = [control, ...Array.from(control.querySelectorAll("div"))].find(isFilled);
      const svg = control.querySelector("svg");
      let ink: { left: number; right: number };
      if (disc) ink = disc.getBoundingClientRect();
      else if (svg) ink = glyphInk(svg);
      else continue;
      inkLeft = Math.min(inkLeft, ink.left);
      inkRight = Math.max(inkRight, ink.right);
    }
    return { textLeft, textRight, inkLeft, inkRight };
  });
}

/** The toolbar's outer ink sits on the text column's edges, within half a pixel. */
export async function expectComposerToolbarOnTextRails(page: Page): Promise<void> {
  const rails = await readComposerToolbarRails(page);
  const message = JSON.stringify(rails);
  expect(Math.abs(rails.inkLeft - rails.textLeft), message).toBeLessThanOrEqual(0.5);
  expect(Math.abs(rails.inkRight - rails.textRight), message).toBeLessThanOrEqual(0.5);
}
