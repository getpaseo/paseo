import { expect, type Locator } from "@playwright/test";

interface SettledOptions {
  timeout?: number;
  durationMs?: number;
  intervalMs?: number;
  heightTolerance?: number;
}

interface Sample {
  text: string;
  height: number;
}

const DEFAULT_DURATION_MS = 1_500;
const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_HEIGHT_TOLERANCE = 1;

async function sample(locator: Locator): Promise<Sample> {
  const [text, box] = await Promise.all([locator.textContent(), locator.boundingBox()]);
  if (!box) {
    throw new Error("Expected locator to keep a bounding box while sampling settledness.");
  }
  return { text: text ?? "", height: box.height };
}

async function collectSamples(locator: Locator, options?: SettledOptions): Promise<Sample[]> {
  await expect(locator).toBeVisible({ timeout: options?.timeout ?? 30_000 });

  const durationMs = options?.durationMs ?? DEFAULT_DURATION_MS;
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const samples: Sample[] = [];
  const deadline = Date.now() + durationMs;

  while (Date.now() <= deadline || samples.length < 2) {
    samples.push(await sample(locator));
    await locator.page().waitForTimeout(intervalMs);
  }

  return samples;
}

function assertStableHeight(samples: Sample[], tolerance: number): void {
  const heights = samples.map((entry) => entry.height);
  const minHeight = Math.min(...heights);
  const maxHeight = Math.max(...heights);
  expect(maxHeight - minHeight, `height changed by more than ${tolerance}px`).toBeLessThanOrEqual(
    tolerance,
  );
}

function assertSettledText(samples: Sample[]): void {
  let stableText: string | null = null;
  let previousText: string | null = null;

  for (const entry of samples) {
    if (stableText !== null && entry.text !== stableText) {
      throw new Error(
        `Text changed after settling. Expected ${JSON.stringify(stableText)}, received ${JSON.stringify(entry.text)}.`,
      );
    }

    if (previousText === entry.text) {
      stableText = entry.text;
    }
    previousText = entry.text;
  }

  if (stableText === null) {
    throw new Error("Text did not reach a stable value during the settledness window.");
  }
}

export async function expectSettled(locator: Locator, options?: SettledOptions): Promise<void> {
  const samples = await collectSamples(locator, options);
  assertSettledText(samples);
  assertStableHeight(samples, options?.heightTolerance ?? DEFAULT_HEIGHT_TOLERANCE);
}

export async function expectStableHeight(
  locator: Locator,
  options?: SettledOptions,
): Promise<void> {
  const samples = await collectSamples(locator, options);
  assertStableHeight(samples, options?.heightTolerance ?? DEFAULT_HEIGHT_TOLERANCE);
}
