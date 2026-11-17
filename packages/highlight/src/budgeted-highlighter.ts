import { highlightCodeInSteps } from "./highlighter.js";
import type { HighlightToken } from "./types.js";

// Full source, rather than patch size, bounds parser and token allocation work.
// Each token consumes a source code unit or an empty line: at most the byte cap + 1 records.
export const HIGHLIGHT_MAX_SOURCE_BYTES = 768 * 1024;
const SLICE_MS = 4;

/**
 * Returns null when source exceeds the budget or the request is cancelled.
 * The host supplies a real event-loop yield (setImmediate on the daemon).
 * Existing synchronous highlighting remains available for its existing consumers.
 */
export async function highlightCodeWithBudget(
  code: string,
  filename: string,
  options: { yieldToEventLoop: () => Promise<void>; signal?: { readonly aborted: boolean } },
): Promise<HighlightToken[][] | null> {
  if (options.signal?.aborted || exceedsSourceBudget(code)) return null;
  const steps = highlightCodeInSteps(code, filename);
  let sliceStarted = Date.now();
  try {
    for (;;) {
      if (options.signal?.aborted) return null;
      const step = steps.next();
      if (step.done) return step.value;
      if (Date.now() - sliceStarted >= SLICE_MS) {
        await options.yieldToEventLoop();
        sliceStarted = Date.now();
      }
    }
  } finally {
    steps.return([]);
  }
}

function exceedsSourceBudget(code: string): boolean {
  if (code.length > HIGHLIGHT_MAX_SOURCE_BYTES) return true;
  let bytes = 0;
  for (const char of code) {
    const point = char.codePointAt(0)!;
    if (point < 0x80) bytes++;
    else if (point < 0x800) bytes += 2;
    else if (point < 0x10000) bytes += 3;
    else bytes += 4;
    if (bytes > HIGHLIGHT_MAX_SOURCE_BYTES) return true;
  }
  return false;
}
