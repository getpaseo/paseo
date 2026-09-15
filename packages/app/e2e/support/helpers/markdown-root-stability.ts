/**
 * Observes a streaming Markdown block and classifies DOM churn.
 *
 * The word fade wraps each arriving word in a `data-word-fade` span carrying
 * the word's start time, and collapses it back into plain text once the fade
 * has settled, so text nodes around the tail and settled spans come and go by
 * design. When Markdown re-parses and a word's rendered offset shifts, its span
 * is re-created with the same start time and the fade resumes. Two things are
 * defects:
 *
 * - `replacedElements`: an element other than a fade span left the block, so
 *   Markdown re-created a mounted descendant. Text nodes alone cannot form a
 *   Markdown descendant.
 * - `restartedFades`: a fade span was removed before it settled and no span with
 *   that start time was added afterwards, so the word was faded again.
 *
 * Both functions run inside the page through `page.evaluate`, so they must be
 * self-contained: no references to module scope.
 */
import type { Page } from "@playwright/test";

export interface MarkdownRootEvidence {
  addedNodes: number;
  characterDataMutations: number;
  removedNodes: number;
  replacedElements: number;
  restartedFades: number;
}

interface MarkdownRootObserverWindow {
  __markdownRootSettle?: () => MarkdownRootEvidence;
}

export function installMarkdownRootObserver(block: Element): void {
  const fadeDurationMs = 150;
  const frameMs = 16;
  const evidence: MarkdownRootEvidence = {
    addedNodes: 0,
    characterDataMutations: 0,
    removedNodes: 0,
    replacedElements: 0,
    restartedFades: 0,
  };
  // Unsettled removals waiting for a same-start-time addition. An addition
  // only resumes a removal that already happened; React removes the old span
  // before placing the new one within a commit.
  const pendingResumes = new Map<string, number>();

  const fadeSpans = (node: Node): HTMLElement[] => {
    if (!(node instanceof HTMLElement)) return [];
    return node.hasAttribute("data-word-fade")
      ? [node]
      : Array.from(node.querySelectorAll<HTMLElement>("[data-word-fade]"));
  };
  // The renderer collapses a word when its last letter's animation ends. That
  // letter starts at startedAt + spanMs * (letters - 1) / letters.
  const isSettled = (span: HTMLElement) => {
    const letters = Math.max(1, span.childElementCount);
    const settledAt =
      Number(span.dataset.fadeStarted) +
      (Number(span.dataset.fadeSpan) * (letters - 1)) / letters +
      fadeDurationMs;
    return Number.isFinite(settledAt) && Date.now() + frameMs >= settledAt;
  };
  const handle = (records: MutationRecord[]) => {
    for (const record of records) {
      evidence.addedNodes += record.addedNodes.length;
      evidence.removedNodes += record.removedNodes.length;
      if (record.type === "characterData") evidence.characterDataMutations += 1;
      for (const node of record.removedNodes) {
        // Any removed element other than a fade span is a replaced descendant,
        // whatever it contains. Fade spans it carried away were removed too.
        if (node instanceof Element && !node.hasAttribute("data-word-fade")) {
          evidence.replacedElements += 1;
        }
        for (const span of fadeSpans(node)) {
          const started = span.dataset.fadeStarted;
          if (!started || isSettled(span)) continue;
          pendingResumes.set(started, (pendingResumes.get(started) ?? 0) + 1);
        }
      }
      for (const node of record.addedNodes) {
        for (const span of fadeSpans(node)) {
          const started = span.dataset.fadeStarted;
          const pending = started ? pendingResumes.get(started) : undefined;
          if (!started || pending === undefined) continue;
          if (pending > 1) pendingResumes.set(started, pending - 1);
          else pendingResumes.delete(started);
        }
      }
    }
  };
  const observer = new MutationObserver(handle);
  observer.observe(block, { characterData: true, childList: true, subtree: true });
  const settle = () => {
    handle(observer.takeRecords());
    observer.disconnect();
    let restarted = 0;
    for (const count of pendingResumes.values()) restarted += count;
    evidence.restartedFades = restarted;
    return evidence;
  };
  (window as unknown as MarkdownRootObserverWindow).__markdownRootSettle = settle;
}

export function settleMarkdownRootObserver(): MarkdownRootEvidence {
  const settle = (window as unknown as MarkdownRootObserverWindow).__markdownRootSettle;
  if (!settle) throw new Error("installMarkdownRootObserver has not run on this page");
  return settle();
}

// Synthetic streaming block: the same DOM shapes the fade renderer produces,
// driven by hand so each classification can be exercised in isolation.

const SYNTHETIC_BLOCK_ID = "markdown-root-stability-block";

export async function mountObservedSyntheticBlock(page: Page): Promise<void> {
  await page.setContent(`<div id="${SYNTHETIC_BLOCK_ID}"><p>settled </p></div>`);
  const block = await page.locator(`#${SYNTHETIC_BLOCK_ID}`).elementHandle();
  if (!block) throw new Error("Expected the synthetic Markdown block to mount");
  await page.evaluate(installMarkdownRootObserver, block);
}

type SyntheticMutation =
  | "resume-fading-word"
  | "restart-fading-word"
  | "collapse-settled-word"
  | "replace-paragraph"
  | "replace-paragraph-keeping-fading-word";

async function mutateSyntheticBlock(page: Page, mutation: SyntheticMutation): Promise<void> {
  await page.evaluate(
    ([blockId, kind]) => {
      const p = document.querySelector(`#${blockId} > p`) as HTMLElement;
      const fadingWord = (startedAt: number) => {
        const span = document.createElement("span");
        span.setAttribute("data-word-fade", "0");
        span.dataset.fadeStarted = String(startedAt);
        span.dataset.fadeSpan = "60";
        span.textContent = "word";
        return span;
      };
      const replaceParagraphWith = (child?: HTMLElement) => {
        const next = document.createElement("p");
        next.textContent = p.textContent;
        if (child) next.append(child);
        p.replaceWith(next);
      };
      // Wall-clock start times are unsettled at removal unless backdated.
      const now = Date.now();
      switch (kind) {
        case "resume-fading-word":
          p.append(fadingWord(now));
          p.lastElementChild!.remove();
          p.append(fadingWord(now));
          return;
        case "restart-fading-word":
          p.append(fadingWord(now));
          p.lastElementChild!.remove();
          p.append(fadingWord(now + 1));
          return;
        case "collapse-settled-word":
          p.append(fadingWord(now - 10_000));
          p.lastElementChild!.remove();
          p.append("word");
          return;
        case "replace-paragraph":
          replaceParagraphWith();
          return;
        case "replace-paragraph-keeping-fading-word":
          p.append(fadingWord(now));
          replaceParagraphWith(fadingWord(now));
          return;
      }
    },
    [SYNTHETIC_BLOCK_ID, mutation] as const,
  );
}

/** Remove a fading word and re-create it with the same start time. */
export const resumeFadingWord = (page: Page) => mutateSyntheticBlock(page, "resume-fading-word");
/** Remove a fading word and re-create it with a new start time. */
export const restartFadingWord = (page: Page) => mutateSyntheticBlock(page, "restart-fading-word");
/** Collapse a word whose fade already finished back into plain text. */
export const collapseSettledWord = (page: Page) =>
  mutateSyntheticBlock(page, "collapse-settled-word");
/** Re-create the paragraph element with the same text. */
export const replaceParagraph = (page: Page) => mutateSyntheticBlock(page, "replace-paragraph");
/** Re-create the paragraph while carrying its fading word over with the same start time. */
export const replaceParagraphKeepingFadingWord = (page: Page) =>
  mutateSyntheticBlock(page, "replace-paragraph-keeping-fading-word");

export async function readMarkdownRootEvidence(page: Page) {
  const evidence = await page.evaluate(settleMarkdownRootObserver);
  return { replacedElements: evidence.replacedElements, restartedFades: evidence.restartedFades };
}
