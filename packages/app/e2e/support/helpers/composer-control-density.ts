import { expect, type Page } from "@playwright/test";

/**
 * Mode controls intentionally use icon-only triggers. Their accessible mode label and
 * minimum target height must survive tab switches on every painted frame.
 */
interface ToolbarFrame {
  atMs: number;
  controls: Array<{ label: string; height: number }>;
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
      const controls = Array.from(document.querySelectorAll('[data-testid="mode-control"]'))
        .filter((node) => node.getClientRects().length > 0)
        .map((node) => ({
          label: node.getAttribute("aria-label") ?? "",
          height: node.getBoundingClientRect().height,
        }));
      frames.push({ atMs: Math.round(performance.now() - start), controls });
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
  const collapsed = frames.filter((frame) =>
    frame.controls.some((control) => !control.label || control.height < 24),
  );
  expect(collapsed, `collapsed toolbar frames: ${JSON.stringify(collapsed)}`).toEqual([]);
}
