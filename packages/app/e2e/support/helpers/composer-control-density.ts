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
