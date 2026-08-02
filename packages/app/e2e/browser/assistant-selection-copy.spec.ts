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
  '[docs](https://docs.example.com "Reference") and <https://autolink.example.com>.',
  "",
  "`https://example.com/generated` stays code, not a generated link.",
  "",
  "```typescript",
  'const answer = "yes";',
  "```",
  "",
  "````text",
  "before",
  "```",
  "after",
  "````",
  "",
  "| Left | Right | Center |",
  "| :-- | --: | :-: |",
  "| Current \\| active | ~~obsolete~~ | ready |",
].join("\n");

const EXPECTED_WHOLE_SELECTION_MARKDOWN = ASSISTANT_MARKDOWN.replace(
  "<https://autolink.example.com>",
  "[https://autolink.example.com](https://autolink.example.com)",
);

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
    expect(clipboard.plainText).toBe(EXPECTED_WHOLE_SELECTION_MARKDOWN);
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
    expect(clipboard.html).toContain(
      '<a href="https://docs.example.com/" title="Reference">docs</a>',
    );
    expect(clipboard.html).toContain(
      '<a href="https://autolink.example.com/">https://autolink.example.com</a>',
    );
    expect(clipboard.html).toContain("<code>https://example.com/generated</code>");
    expect(clipboard.html).not.toContain(
      '<a href="https://example.com/generated"><code>https://example.com/generated</code></a>',
    );
    expect(clipboard.html).toContain('<code class="language-typescript">');
    expect(clipboard.html).toContain(
      '<pre><code class="language-text">before\n```\nafter\n</code></pre>',
    );
    expect(clipboard.html).toContain("<table>");
    expect(clipboard.html).toContain('<td style="text-align:left">Current | active</td>');
    expect(clipboard.html.match(/<td\b/g)).toHaveLength(3);
    expect(clipboard.html).toContain("<s>obsolete</s>");
    expect(clipboard.html).toContain('<th style="text-align:left">Left</th>');
    expect(clipboard.html).toContain('<th style="text-align:right">Right</th>');
    expect(clipboard.html).toContain('<th style="text-align:center">Center</th>');

    await selectAssistantText(page, "First");
    await copySelection(page);

    const partialClipboard = await readRichClipboard(page);
    expect(partialClipboard.plainText).toBe("- **[First](https://example.com/issues/1)**");
    expect(partialClipboard.html).toContain(
      '<li><strong><a href="https://example.com/issues/1">First</a></strong></li>',
    );

    await selectAssistantText(page, "docs");
    await copySelection(page);

    const titledLinkClipboard = await readRichClipboard(page);
    expect(titledLinkClipboard.plainText).toBe('[docs](https://docs.example.com "Reference")');
    expect(titledLinkClipboard.html).toContain(
      '<a href="https://docs.example.com/" title="Reference">docs</a>',
    );

    await selectAssistantText(page, "https://autolink.example.com");
    await copySelection(page);

    const autolinkClipboard = await readRichClipboard(page);
    expect(autolinkClipboard.plainText).toBe(
      "[https://autolink.example.com](https://autolink.example.com)",
    );
    expect(autolinkClipboard.html).toContain(
      '<a href="https://autolink.example.com/">https://autolink.example.com</a>',
    );

    await selectAssistantTextRange(page, "Seventh item", "Eighth item");
    await copySelection(page);

    const midListClipboard = await readRichClipboard(page);
    expect(midListClipboard.plainText).toBe("7. Seventh item\n8. Eighth item");
    expect(midListClipboard.html).toContain('<ol start="7">');

    await selectAssistantTextRange(page, "Seventh item", "A hard break");
    await copySelection(page);

    const crossBlockClipboard = await readRichClipboard(page);
    expect(crossBlockClipboard.plainText).toBe("7. Seventh item\n8. Eighth item\n\nA hard break");
    expect(crossBlockClipboard.html).toContain('<ol start="7">');

    await selectAssistantText(page, "Current");
    await copySelection(page);

    const partialTableClipboard = await readRichClipboard(page);
    expect(partialTableClipboard.plainText).toBe("Current");
    expect(partialTableClipboard.html).toContain("<p>Current</p>");
    expect(partialTableClipboard.html).not.toContain("&lt;table");
  } finally {
    await agent.cleanup();
  }
});
