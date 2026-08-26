import type { Page } from "@playwright/test";

/**
 * Frame-level sampling of the streaming assistant message, and the two numbers
 * that describe how it reads:
 *
 * - `charsPerFrameCv` — coefficient of variation of characters painted per frame.
 *   This is the smoothness metric. Painting deltas as they land tracks the
 *   arrival lumps, so it is high; pacing the reveal flattens it.
 * - `updateGapP95Ms` — how long the text can sit unchanged mid-stream. This is
 *   the stall metric, and it is what stops smoothness being bought with lag.
 *
 * Both are needed. A stream that never updates is perfectly smooth.
 */

export interface StreamFrameSample {
  timestampMs: number;
  growthChars: number;
  firstPaintChars: number;
}

export interface StreamSmoothnessReport {
  sampleWindowMs: number;
  frames: number;
  growthFrames: number;
  charsPainted: number;
  meanCharsPerFrame: number;
  maxCharsInOneFrame: number;
  charsPerFrameCv: number;
  firstPaintFrames: number;
  firstPaintChars: number;
  maxFirstPaintCharsInOneFrame: number;
  handoverGrowthFrames: number;
  handoverGrowthChars: number;
  maxHandoverGrowthCharsInOneFrame: number;
  updateGapP50Ms: number;
  updateGapP95Ms: number;
  updateGapMaxMs: number;
}

/**
 * Record text growth on every mounted assistant message once per frame.
 *
 * Message occurrence identity separates paced growth from first paint. Completed markdown
 * blocks move into canonical timeline rows while a turn streams, remounting text
 * that was already visible. Counting the new node's full length as growth would
 * report that handover as a large reveal even though no text appeared on screen.
 * First paints stay in the report as a separate diagnostic.
 *
 * Runs entirely in the page so the sampling clock is the same clock the reveal
 * runs on. Waits for the text to start moving first, so a slow model's
 * time-to-first-token is not counted as a stall.
 */
export async function sampleStreamFrames(
  page: Page,
  options: { sampleWindowMs: number; startTimeoutMs?: number },
): Promise<StreamFrameSample[]> {
  const startTimeoutMs = options.startTimeoutMs ?? 60_000;
  return await page.evaluate(
    async ({ sampleWindowMs, startTimeoutMs: waitMs }) => {
      const readLength = () => {
        let total = 0;
        for (const node of document.querySelectorAll('[data-testid="assistant-message"]')) {
          total += node.textContent?.length ?? 0;
        }
        return total;
      };

      const waitStart = performance.now();
      const base = readLength();
      await new Promise<void>((resolve) => {
        const poll = () => {
          if (readLength() > base + 20 || performance.now() - waitStart > waitMs) {
            resolve();
            return;
          }
          requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      });

      let previousLengths = new Map<string, number>();
      for (const node of document.querySelectorAll('[data-testid="assistant-message"]')) {
        const key = node.getAttribute("data-reveal-key");
        const length = Number(node.getAttribute("data-reveal-length"));
        if (key !== null && Number.isFinite(length)) {
          previousLengths.set(key, length);
        }
      }

      const samples: Array<{
        timestampMs: number;
        growthChars: number;
        firstPaintChars: number;
      }> = [];
      await new Promise<void>((resolve) => {
        const start = performance.now();
        const tick = (now: number) => {
          const currentLengths = new Map<string, number>();
          let growthChars = 0;
          let firstPaintChars = 0;
          for (const node of document.querySelectorAll('[data-testid="assistant-message"]')) {
            const key = node.getAttribute("data-reveal-key");
            const currentLength = Number(node.getAttribute("data-reveal-length"));
            if (key === null || !Number.isFinite(currentLength)) {
              continue;
            }
            const previousLength = previousLengths.get(key);
            if (previousLength === undefined || currentLength < previousLength) {
              firstPaintChars += currentLength;
            } else {
              const nodeGrowth = currentLength - previousLength;
              growthChars += nodeGrowth;
            }
            currentLengths.set(key, currentLength);
          }
          samples.push({
            timestampMs: now,
            growthChars,
            firstPaintChars,
          });
          previousLengths = currentLengths;
          if (now - start >= sampleWindowMs) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return samples;
    },
    { sampleWindowMs: options.sampleWindowMs, startTimeoutMs },
  );
}

export function computePercentile(samples: readonly number[], percentile: number): number {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Reduce frame samples to the report. Frames outside the streaming window are
 * dropped: leading idle is time-to-first-token, and trailing idle means the turn
 * ended mid-sample. First-paint frames are structural handovers. Existing blocks
 * may also snap complete on those frames, so their growth is reported separately
 * from the paced-growth CV.
 */
export function summarizeStreamSmoothness(
  samples: readonly StreamFrameSample[],
  sampleWindowMs: number,
): StreamSmoothnessReport {
  const deltas: number[] = [];
  const gapsMs: number[] = [];
  let lastUpdateAtMs: number | null = null;
  let firstGrowth = -1;
  let lastGrowth = -1;
  const handoverGrowths: number[] = [];

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const isHandover = sample.firstPaintChars > 0;
    const growth = isHandover ? 0 : sample.growthChars;
    if (isHandover && sample.growthChars > 0) {
      handoverGrowths.push(sample.growthChars);
      lastUpdateAtMs = sample.timestampMs;
    }
    deltas.push(growth);
    if (growth > 0) {
      if (firstGrowth === -1) {
        firstGrowth = deltas.length - 1;
      }
      lastGrowth = deltas.length - 1;
      if (lastUpdateAtMs !== null) {
        gapsMs.push(samples[index].timestampMs - lastUpdateAtMs);
      }
      lastUpdateAtMs = samples[index].timestampMs;
    }
  }

  const active = firstGrowth === -1 ? [] : deltas.slice(firstGrowth, lastGrowth + 1);
  const charsPainted = active.reduce((sum, delta) => sum + delta, 0);
  const mean = active.length > 0 ? charsPainted / active.length : 0;
  const variance =
    active.length > 0
      ? active.reduce((sum, delta) => sum + (delta - mean) ** 2, 0) / active.length
      : 0;
  const firstPaints = samples.map((sample) => sample.firstPaintChars).filter((chars) => chars > 0);

  return {
    sampleWindowMs,
    frames: active.length,
    growthFrames: active.filter((delta) => delta > 0).length,
    charsPainted,
    meanCharsPerFrame: round2(mean),
    maxCharsInOneFrame: active.length > 0 ? Math.max(...active) : 0,
    charsPerFrameCv: mean === 0 ? Number.POSITIVE_INFINITY : round2(Math.sqrt(variance) / mean),
    firstPaintFrames: firstPaints.length,
    firstPaintChars: firstPaints.reduce((sum, chars) => sum + chars, 0),
    maxFirstPaintCharsInOneFrame: firstPaints.length > 0 ? Math.max(...firstPaints) : 0,
    handoverGrowthFrames: handoverGrowths.length,
    handoverGrowthChars: handoverGrowths.reduce((sum, chars) => sum + chars, 0),
    maxHandoverGrowthCharsInOneFrame: handoverGrowths.length > 0 ? Math.max(...handoverGrowths) : 0,
    updateGapP50Ms: round2(computePercentile(gapsMs, 50)),
    updateGapP95Ms: round2(computePercentile(gapsMs, 95)),
    updateGapMaxMs: gapsMs.length > 0 ? round2(Math.max(...gapsMs)) : 0,
  };
}
