import type { BrowserContext } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const ASSISTANT_MARKDOWN = [
  "Direct matches:",
  "",
  "- **[First issue](https://example.com/issues/1)**: exact `apply_patch` failure.",
  "- [Second issue](https://example.com/issues/2): repeated sandbox setup.",
  "",
  "5. Fifth item",
  "6. Sixth item",
  "7. Seventh item",
  "8. Eighth item",
  "",
  "A hard break  ",
  "stays hard.",
  "",
  "www.example.com stays plain Markdown text.",
  "",
  "`https://example.com/generated` stays code, not a generated link.",
  "",
  "```typescript",
  'const answer = "yes";',
  "```",
  "",
  "| Status | Result |",
  "| --- | --- |",
  "| Current | ~~obsolete~~ |",
].join("\n");

interface ClipboardContent {
  html: string;
  plainText: string;
}

async function allowRichClipboard(context: BrowserContext): Promise<void> {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
}

async function selectAssistantMessage(page: Page): Promise<void> {
  const assistantMessage = page.getByTestId("assistant-message").filter({
    hasText: "Direct matches:",
  });
  await expect(assistantMessage).toBeVisible();
  await assistantMessage.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

async function selectAssistantText(page: Page, text: string): Promise<void> {
  await selectAssistantTextRange(page, text, text);
}

async function selectAssistantTextRange(
  page: Page,
  startText: string,
  endText: string,
): Promise<void> {
  const assistantMessage = page.getByTestId("assistant-message").filter({
    hasText: "Direct matches:",
  });
  await assistantMessage.evaluate(
    (element, selectedRange) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let startNode: Node | null = null;
      let startOffset = -1;
      let endNode: Node | null = null;
      let endOffset = -1;
      let textNode = walker.nextNode();
      while (textNode) {
        if (!startNode) {
          const offset = textNode.textContent?.indexOf(selectedRange.startText) ?? -1;
          if (offset >= 0) {
            startNode = textNode;
            startOffset = offset;
          }
        }
        if (startNode) {
          const offset = textNode.textContent?.indexOf(selectedRange.endText) ?? -1;
          if (offset >= 0) {
            endNode = textNode;
            endOffset = offset + selectedRange.endText.length;
            break;
          }
        }
        textNode = walker.nextNode();
      }
      if (!startNode || !endNode) {
        throw new Error(
          `Could not find assistant text range: ${selectedRange.startText} — ${selectedRange.endText}`,
        );
      }
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
    { startText, endText },
  );
}

async function copySelection(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+c");
}

async function readRichClipboard(page: Page): Promise<ClipboardContent> {
  return page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const item = items[0];
    if (!item) {
      throw new Error("Expected clipboard content");
    }
    return {
      html: await (await item.getType("text/html")).text(),
      plainText: await (await item.getType("text/plain")).text(),
    };
  });
}

test("copying an assistant selection preserves Markdown structure and links", async ({
  context,
  page,
}) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "assistant-selection-copy-",
    title: "Assistant selection copy",
    initialPrompt: "Render the clipboard fixture.",
    featureValues: { mockAssistantResponse: ASSISTANT_MARKDOWN },
  });

  try {
    await allowRichClipboard(context);
    await agent.client.waitForAgentUpsert(
      agent.agentId,
      (snapshot) => snapshot.status === "idle",
      30_000,
    );
    await openAgentRoute(page, agent);
    await selectAssistantMessage(page);
    await copySelection(page);

    const clipboard = await readRichClipboard(page);
    expect(clipboard.plainText).toBe(ASSISTANT_MARKDOWN);
    expect(clipboard.html).toContain("<ul>");
    expect(clipboard.html).toContain(
      '<strong><a href="https://example.com/issues/1">First issue</a></strong>',
    );
    expect(clipboard.html).toContain("<code>apply_patch</code>");
    expect(clipboard.html).toContain('<ol start="5">');
    expect(clipboard.html).toContain("A hard break<br>");
    expect(clipboard.html).toContain(
      '<a href="http://www.example.com/">www.example.com</a> stays plain Markdown text.',
    );
    expect(clipboard.html).toContain("<code>https://example.com/generated</code>");
    expect(clipboard.html).not.toContain(
      '<a href="https://example.com/generated"><code>https://example.com/generated</code></a>',
    );
    expect(clipboard.html).toContain('<code class="language-typescript">');
    expect(clipboard.html).toContain("<table>");
    expect(clipboard.html).toContain("<s>obsolete</s>");

    await selectAssistantText(page, "First");
    await copySelection(page);

    const partialClipboard = await readRichClipboard(page);
    expect(partialClipboard.plainText).toBe("- **[First](https://example.com/issues/1)**");
    expect(partialClipboard.html).toContain(
      '<li><strong><a href="https://example.com/issues/1">First</a></strong></li>',
    );

    await selectAssistantTextRange(page, "Seventh item", "Eighth item");
    await copySelection(page);

    const midListClipboard = await readRichClipboard(page);
    expect(midListClipboard.plainText).toBe("7. Seventh item\n8. Eighth item");
    expect(midListClipboard.html).toContain('<ol start="7">');
  } finally {
    await agent.cleanup();
  }
});
