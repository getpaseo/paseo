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

/** One painted frame of the composer's trailing controls: the slot and what sits beside it. */
export interface TrailingActionFrame {
  atMs: number;
  /** Every trailing action on screen, as `label` or `label (disabled)`. */
  actions: string[];
  slotX: number | null;
  micX: number | null;
  ringX: number | null;
  ringWidth: number | null;
}

declare global {
  interface Window {
    __trailingActionFrames?: TrailingActionFrame[];
    __trailingActionStop?: () => void;
  }
}

const TRAILING_ACTION_LABELS = [
  "Enable Voice mode",
  "Send message",
  "Queue message",
  "Send and interrupt",
  "Send and steer",
  "Interrupt agent",
  "Stop agent",
];

/**
 * Records every painted frame of the visible composer's trailing controls. Takes one sample before
 * the first paint, so input that lands right after this resolves still has a frame to compare to.
 */
export async function recordTrailingActionFrames(page: Page): Promise<void> {
  await page.evaluate((labels) => {
    const frames: TrailingActionFrame[] = [];
    window.__trailingActionFrames = frames;
    const start = performance.now();
    const visibleRoot = () =>
      Array.from(document.querySelectorAll('[data-testid="message-input-root"]')).find(
        (root) => root.getClientRects().length > 0,
      );
    const sample = () => {
      const root = visibleRoot();
      const control = (selector: string) =>
        Array.from(root?.querySelectorAll(selector) ?? []).find(
          (node) => node.getClientRects().length > 0,
        );
      const actions = labels.flatMap((label) => {
        const node = control(`[aria-label="${label}"]`);
        if (!node) return [];
        return [node.getAttribute("aria-disabled") === "true" ? `${label} (disabled)` : label];
      });
      const slot = labels.map((label) => control(`[aria-label="${label}"]`)).find(Boolean);
      const mic = control('[aria-label="Start dictation"]');
      const ring = control('[aria-label^="Context window"]');
      frames.push({
        atMs: Math.round(performance.now() - start),
        actions,
        slotX: slot ? slot.getBoundingClientRect().x : null,
        micX: mic ? mic.getBoundingClientRect().x : null,
        ringX: ring ? ring.getBoundingClientRect().x : null,
        ringWidth: ring ? ring.getBoundingClientRect().width : null,
      });
    };
    sample();
    let running = true;
    const tick = () => {
      if (!running) return;
      sample();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__trailingActionStop = () => {
      running = false;
    };
  }, TRAILING_ACTION_LABELS);
}

export async function readTrailingActionFrames(page: Page): Promise<TrailingActionFrame[]> {
  return page.evaluate(() => {
    window.__trailingActionStop?.();
    return window.__trailingActionFrames ?? [];
  });
}

/**
 * Every frame of the span shows exactly one trailing action, in the one slot, moving straight from
 * `from` to `to`, with the mic and context ring where they started.
 */
export function expectTrailingActionSwap(
  frames: TrailingActionFrame[],
  expected: { from: string; to: string },
): void {
  expect(frames.length).toBeGreaterThan(1);
  const [first] = frames;
  const wrongFrames = frames.filter(
    (frame) =>
      frame.actions.length !== 1 ||
      frame.slotX !== first.slotX ||
      frame.micX !== first.micX ||
      frame.ringX !== first.ringX ||
      frame.ringWidth !== first.ringWidth,
  );
  expect(wrongFrames, `frames that moved or showed the wrong action`).toEqual([]);
  const sequence = frames
    .map((frame) => frame.actions[0])
    .filter((action, index, all) => action !== all[index - 1]);
  expect(sequence).toEqual([expected.from, expected.to]);
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

/** The labels at the widths where the folded model control changes what it shows. */
export interface ModelTriggerLabelSweep {
  /** The labels at the widest width. */
  widest: ModelTriggerLabelState & { width: number };
  /** The first width at which the thinking label is hidden. */
  thinkingHidden: ModelTriggerLabelState & { width: number };
  /** The first width at which the model label is truncated. */
  modelTruncated: ModelTriggerLabelState & { width: number };
}

/**
 * Narrows the viewport step by step and records where the thinking label disappears and where the
 * model label first truncates.
 */
export async function sweepModelTriggerLabels(
  page: Page,
  widths: { from: number; to: number; step: number; height: number },
): Promise<ModelTriggerLabelSweep> {
  const steps: (ModelTriggerLabelState & { width: number })[] = [];
  for (let width = widths.from; width >= widths.to; width -= widths.step) {
    await page.setViewportSize({ width, height: widths.height });
    const labels = await readSettledModelTriggerLabels(page);
    steps.push({ ...labels, width });
    if (labels.modelTruncated || !labels.modelShown) break;
  }
  const thinkingHidden = steps.find((step) => !step.thinkingShown);
  const modelTruncated = steps.find((step) => step.modelTruncated);
  if (!thinkingHidden || !modelTruncated) {
    throw new Error(`the sweep never hid the thinking label and truncated the model label`);
  }
  return { widest: steps[0], thinkingHidden, modelTruncated };
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

/** Where the composer toolbar's ends sit against the composer, in CSS pixels. */
export interface ComposerToolbarRails {
  /** Where the text column starts. */
  textLeft: number;
  /** Where the toolbar's leftmost ink starts. */
  inkLeft: number;
  /** How far the trailing disc sits from the composer's right edge. */
  discRightInset: number;
  /** How far the trailing disc sits from the composer's bottom edge. */
  discBottomInset: number;
}

/**
 * Reads where the toolbar's ink starts against the text column and where the trailing disc sits
 * in the composer's corner. A control's ink is its filled disc when it has one, otherwise its
 * glyph's stroked geometry.
 */
export async function readComposerToolbarRails(page: Page): Promise<ComposerToolbarRails> {
  const root = page.locator('[data-testid="message-input-root"]:visible').first();
  return root.evaluate((element) => {
    const textarea = element.querySelector("textarea");
    if (!textarea) throw new Error("composer has no text input");
    const composerRect = element.getBoundingClientRect();
    const textLeft =
      textarea.getBoundingClientRect().left +
      Number.parseFloat(getComputedStyle(textarea).paddingLeft);

    const isFilled = (node: Element) => {
      const color = getComputedStyle(node).backgroundColor;
      return color !== "" && color !== "transparent" && !/rgba\(.*,\s*0\)$/.test(color);
    };
    const glyphInkLeft = (svg: SVGSVGElement) => {
      let left = Number.POSITIVE_INFINITY;
      for (const shape of Array.from(
        svg.querySelectorAll<SVGGraphicsElement>("path, circle, rect, line, polyline"),
      )) {
        const matrix = shape.getScreenCTM();
        if (!matrix) continue;
        const box = shape.getBBox();
        const stroke = Number.parseFloat(getComputedStyle(shape).strokeWidth || "0");
        left = Math.min(left, matrix.a * (box.x - stroke / 2) + matrix.e);
      }
      return left;
    };

    const band = composerRect.bottom - 64;
    let inkLeft = Number.POSITIVE_INFINITY;
    let trailingDisc: DOMRect | null = null;
    for (const control of Array.from(element.querySelectorAll('[role="button"]'))) {
      const rect = control.getBoundingClientRect();
      if (rect.width === 0 || rect.top < band) continue;
      const disc = [control, ...Array.from(control.querySelectorAll("div"))].find(isFilled);
      const svg = control.querySelector("svg");
      if (disc) {
        const discRect = disc.getBoundingClientRect();
        inkLeft = Math.min(inkLeft, discRect.left);
        if (!trailingDisc || discRect.right > trailingDisc.right) trailingDisc = discRect;
      } else if (svg) {
        inkLeft = Math.min(inkLeft, glyphInkLeft(svg));
      }
    }
    if (!trailingDisc) throw new Error("composer toolbar has no trailing disc");
    return {
      textLeft,
      inkLeft,
      discRightInset: composerRect.right - trailingDisc.right,
      discBottomInset: composerRect.bottom - trailingDisc.bottom,
    };
  });
}

/**
 * The toolbar's left ink sits on the text column's edge, and its trailing disc nests into the
 * corner, as far from the right edge as from the bottom edge. Within half a pixel.
 */
export async function expectComposerToolbarOnTextRails(page: Page): Promise<void> {
  const rails = await readComposerToolbarRails(page);
  // A precision of 0 digits passes within half a pixel.
  expect(rails.inkLeft).toBeCloseTo(rails.textLeft, 0);
  expect(rails.discRightInset).toBeCloseTo(rails.discBottomInset, 0);
}
