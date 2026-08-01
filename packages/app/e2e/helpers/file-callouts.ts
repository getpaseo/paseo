import type { Page } from "@playwright/test";
import { expect } from "../fixtures";

export async function recordFileCallouts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const callouts: string[] = [];
    const recordAlert = (alert: Element) => {
      const text = alert.textContent?.trim();
      if (text && !callouts.includes(text)) callouts.push(text);
    };
    const record = (records: MutationRecord[]) => {
      for (const mutation of records) {
        if (
          !(mutation.target instanceof Element) ||
          !mutation.target.closest('[data-testid="workspace-file-pane"]')
        ) {
          continue;
        }
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches('[role="alert"]')) recordAlert(node);
          for (const alert of node.querySelectorAll('[role="alert"]')) recordAlert(alert);
        }
      }
    };
    const observer = new MutationObserver(record);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    Object.assign(globalThis, { __PASEO_RECORDED_FILE_CALLOUTS__: callouts });
  });
}

export async function expectFileCalloutWasRendered(page: Page, title: string): Promise<void> {
  await expect
    .poll(() => recordedFileCallouts(page))
    .toEqual(expect.arrayContaining([expect.stringContaining(title)]));
}

export async function expectNoFileCalloutWasRendered(page: Page): Promise<void> {
  await expect.poll(() => recordedFileCallouts(page)).toEqual([]);
}

function recordedFileCallouts(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (globalThis as typeof globalThis & { __PASEO_RECORDED_FILE_CALLOUTS__?: string[] })
        .__PASEO_RECORDED_FILE_CALLOUTS__ ?? [],
  );
}
