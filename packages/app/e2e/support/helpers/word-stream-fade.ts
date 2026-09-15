import { expect, type Page, type TestInfo } from "@playwright/test";
import { test as base } from "../fixtures";
import { startRunningMockAgent } from "./composer";
import { awaitAssistantMessage } from "./agent-stream";

export const test = base.extend<{ streamingReply: Page }>({
  streamingReply: async ({ page }, provide) => {
    const agent = await startRunningMockAgent(page, {
      prefix: "word-fade-",
      model: "bursty-stream",
      prompt: "Stream bursty output for word fade verification.",
    });
    try {
      await awaitAssistantMessage(page);
      await provide(page);
    } finally {
      await agent.cleanup();
    }
  },
});

export async function expectContinuousWordFade(page: Page, testInfo: TestInfo): Promise<void> {
  const report = await sampleWordFades(page);
  await testInfo.attach("word-fade-observations", {
    body: JSON.stringify(report),
    contentType: "application/json",
  });
  expect(report.directionalFades).toBeGreaterThan(10);
  expect(report.reverseFades).toBe(0);
  expect(report.boundaryReversals).toBe(0);
  expect(report.maxWidthDelta).toBeLessThan(0.5);
  expect(report.maxActiveLetters).toBeLessThan(500);
}

export async function sampleWordFades(page: Page) {
  return page.evaluate(async () => {
    const started = performance.now();
    let directionalFades = 0;
    let reverseFades = 0;
    let boundaryReversals = 0;
    let maxBoundaryReversal = 0;
    let maxWidthDelta = 0;
    let maxActiveLetters = 0;
    while (performance.now() - started < 4_000) {
      const words = Array.from(document.querySelectorAll<HTMLElement>("[data-word-fade]"));
      maxActiveLetters = Math.max(
        maxActiveLetters,
        words.reduce((sum, word) => sum + word.children.length, 0),
      );
      // One front across the whole line: a word's first letter is never more
      // opaque than the last letter of the fading word before it on that line.
      let previous: { top: number; opacity: number } | null = null;
      for (const word of words) {
        const letters = Array.from(word.children);
        const rect = word.getBoundingClientRect();
        const first = Number(getComputedStyle(letters[0]!).opacity);
        const last = Number(getComputedStyle(letters.at(-1)!).opacity);
        if (previous && Math.abs(previous.top - rect.top) < 1 && first > previous.opacity + 0.02) {
          boundaryReversals++;
          maxBoundaryReversal = Math.max(maxBoundaryReversal, first - previous.opacity);
        }
        previous = { top: rect.top, opacity: last };
        if (letters.length < 3) continue;
        if (first > last) directionalFades++;
        if (last > first) reverseFades++;
        if (word.getClientRects().length !== 1) continue;
        // Compare shaped text with the same word without transient spans.
        const plain = document.createElement("span");
        plain.textContent = word.textContent;
        Object.assign(plain.style, {
          position: "absolute",
          whiteSpace: "pre",
          visibility: "hidden",
        });
        word.parentElement!.appendChild(plain);
        maxWidthDelta = Math.max(
          maxWidthDelta,
          Math.abs(plain.getBoundingClientRect().width - word.getBoundingClientRect().width),
        );
        plain.remove();
      }
      await new Promise(requestAnimationFrame);
    }
    return {
      directionalFades,
      reverseFades,
      boundaryReversals,
      maxBoundaryReversal,
      maxWidthDelta,
      maxActiveLetters,
    };
  });
}

export async function expectSettledSelectableText(page: Page): Promise<void> {
  await expect(page.locator("[data-word-fade]")).toHaveCount(0);
  const result = await page
    .getByTestId("assistant-message")
    .first()
    .evaluate((message) => {
      const range = document.createRange();
      range.selectNodeContents(message);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const selectedText = { expected: message.textContent, selected: selection.toString() };
      selection.removeAllRanges();
      return selectedText;
    });
  expect(result.selected.length).toBeGreaterThan(0);
  expect(result.selected.replace(/\s/g, "")).toBe(result.expected!.replace(/\s/g, ""));
}
