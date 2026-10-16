import type { Locator, Page } from "@playwright/test";

/**
 * Locate assistant rows by source-message identity.
 */
export function assistantMessageBlocks(page: Page): Locator {
  return page.locator("[data-message-id]").filter({ has: page.getByTestId("assistant-message") });
}

/** Select assistant text from the start of `startText` to the end of `endText`. */
export async function selectAssistantTextRange(
  page: Page,
  startText: string,
  endText: string,
): Promise<void> {
  await assistantMessageBlocks(page).evaluateAll(
    (blocks, selectedRange) => {
      // The message's text nodes in reading order, across every block row.
      const nodes: Text[] = [];
      for (const block of blocks) {
        const blockWalker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        let found = blockWalker.nextNode();
        while (found) {
          nodes.push(found as Text);
          found = blockWalker.nextNode();
        }
      }
      const text = nodes.map((node) => node.data).join("");
      const start = text.indexOf(selectedRange.startText);
      const end = text.indexOf(selectedRange.endText, start);
      if (start < 0 || end < 0)
        throw new Error(
          `Could not find assistant text range: ${selectedRange.startText} — ${selectedRange.endText}`,
        );
      const boundary = (offset: number, isEnd = false): [Text, number] => {
        for (const node of nodes) {
          if (offset < node.length || (isEnd && offset === node.length)) return [node, offset];
          offset -= node.length;
        }
        throw new Error("Selection extends beyond message");
      };
      const range = document.createRange();
      range.setStart(...boundary(start));
      range.setEnd(...boundary(end + selectedRange.endText.length, true));
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
    { startText, endText },
  );
}
