import type { BrowserContext } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const CROSS_STRUCTURE_MARKDOWN = [
  "# P1 — High-value UI behavior",
  "",
  "5. Claude model and thinking preferences",
  "",
  "   - Switch Claude models and confirm each model retains its own thinking choice.",
  "   - Cover new-workspace drafts, queued launches, schedules, and editing existing schedules.",
  "   - Confirm Opus 5 exposes the Fast toggle.",
  "   - Smoke with an older saved Fabel/model alias and with daemon/client version drift.",
  "",
  "6. Chat, composer, and timeline stability",
].join("\n");

const ASSISTANT_MARKDOWN = [
  CROSS_STRUCTURE_MARKDOWN,
  "",
  "Direct matches:",
  "",
  "Formatted **strong prose**, _emphasized prose_, and ~~struck prose~~.",
  "",
  "- **[First issue](https://example.com/issues/1)**: exact `apply_patch` failure.",
  "- [Second issue](https://example.com/issues/2): repeated sandbox setup.",
  "",
  "5. Fifth item",
  "6. Sixth item",
  "7. Seventh item",
  "8. Eighth item",
  "",
  "Nested list:",
  "",
  "3. Outer three",
  "",
  "   7. Inner seven",
  "   8. Inner eight",
  "   9. Inner nine",
  "",
  "A hard break  ",
  "stays hard.",
  "",
  "www.example.com stays plain Markdown text.",
  "",
  '[docs](https://docs.example.com "Reference") and <https://autolink.example.com>.',
  "",
  "[workspace file](file:///tmp/paseo%20notes.md#L4)",
  "",
  "`https://example.com/generated` stays code, not a generated link.",
  "",
  "```typescript",
  'const answer = "yes";',
  "  return answer;",
  "```",
  "",
  "After code.",
  "",
  "```bash",
  "echo trailing",
  "",
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
  `${CROSS_STRUCTURE_MARKDOWN}\n\n`,
  "",
)
  .replace(
    "<https://autolink.example.com>",
    "[https://autolink.example.com](https://autolink.example.com)",
  )
  .replace(
    "3. Outer three\n\n   7. Inner seven\n   8. Inner eight\n   9. Inner nine",
    "3. Outer three\n    7. Inner seven\n    8. Inner eight\n    9. Inner nine",
  )
  // Rendering drops the blank line before a closing fence, so copying cannot bring it
  // back. The fence is here to cover a body that ends in more than one newline.
  .replace("```bash\necho trailing\n\n```", "```bash\necho trailing\n```");

interface ClipboardContent {
  html: string;
  plainText: string;
}

async function allowRichClipboard(context: BrowserContext): Promise<void> {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
}

async function selectStructuredClipboardFixture(page: Page): Promise<void> {
  await selectAssistantTextRange(page, "Direct matches:", "ready");
}

async function selectAssistantElement(page: Page, selector: string): Promise<void> {
  const assistantMessage = page.getByTestId("assistant-message").filter({
    hasText: "Direct matches:",
  });
  await assistantMessage.locator(selector).evaluate((element) => {
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

async function selectAssistantListItemFromMarker(
  page: Page,
  listTag: "ol" | "ul",
  itemText: string,
  endText: string,
): Promise<void> {
  const assistantMessage = page.getByTestId("assistant-message").filter({
    hasText: "Direct matches:",
  });
  const item = assistantMessage
    .locator(`[data-paseo-markdown-tag="${listTag}"]`)
    .filter({ hasText: itemText })
    .locator(':scope > [data-paseo-markdown-tag="li"]')
    .filter({ hasText: itemText });

  await item.evaluate((element, selectedEndText) => {
    const marker = element.querySelector(':scope > [data-paseo-markdown-list-marker="true"]');
    const markerText = marker?.firstChild;
    if (!(markerText instanceof Text)) {
      throw new Error("Expected rendered list marker text");
    }

    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let endNode: Text | null = null;
    let endOffset = -1;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const offset = node.textContent?.indexOf(selectedEndText) ?? -1;
      if (node instanceof Text && offset >= 0) {
        endNode = node;
        endOffset = offset + selectedEndText.length;
        break;
      }
    }
    if (!endNode) {
      throw new Error(`Could not find list item selection end: ${selectedEndText}`);
    }

    const range = document.createRange();
    range.setStart(markerText, 0);
    range.setEnd(endNode, endOffset);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, endText);
}

async function doubleClickAssistantMarkdownText(
  page: Page,
  tag: "code" | "strong",
  text: string,
): Promise<void> {
  const assistantMessage = page.getByTestId("assistant-message").filter({
    hasText: "Direct matches:",
  });
  await assistantMessage
    .locator(`[data-paseo-markdown-tag="${tag}"]`)
    .filter({ hasText: text })
    .dblclick({ position: { x: 5, y: 5 } });
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

/**
 * Select from `startText` into the middle of the next rendered code line.
 *
 * Highlighted code splits a line across one text node per syntax token and puts the
 * newline in a node of its own, so this is a partial selection that crosses a line
 * break — the shape whose whitespace Turndown would collapse.
 */
async function selectAssistantAcrossCodeLines(
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
      let textNode = walker.nextNode();
      while (textNode) {
        if (!startNode) {
          const offset = textNode.textContent?.indexOf(selectedRange.startText) ?? -1;
          if (offset >= 0) {
            startNode = textNode;
            startOffset = offset;
          }
          textNode = walker.nextNode();
          continue;
        }
        const endOffset = textNode.textContent?.indexOf(selectedRange.endText) ?? -1;
        if (endOffset >= 0) {
          const range = document.createRange();
          range.setStart(startNode, startOffset);
          range.setEnd(textNode, endOffset + selectedRange.endText.length);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          return;
        }
        textNode = walker.nextNode();
      }
      throw new Error(
        `Could not find a code range: ${selectedRange.startText} — ${selectedRange.endText}`,
      );
    },
    { startText, endText },
  );
}

async function copySelection(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+c");
}

/** The Copy button writes text/plain only, so the rich reader would throw on it. */
async function readPlainClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
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
  await page.addInitScript(() => {
    localStorage.setItem("@paseo:app-settings", JSON.stringify({ uiFontFamily: "serif" }));
  });
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

    const assistantMessage = page.getByTestId("assistant-message").filter({
      hasText: "Direct matches:",
    });
    for (const [tag, text] of [
      ["strong", "strong prose"],
      ["em", "emphasized prose"],
      ["s", "struck prose"],
    ]) {
      const formattedProse = assistantMessage
        .locator(`[data-paseo-markdown-tag="${tag}"]`)
        .filter({ hasText: text });
      await expect(formattedProse).toHaveCSS("font-family", "serif");
      await expect(formattedProse).not.toHaveAttribute("data-pmono");
    }
    const inlineCode = assistantMessage
      .locator('[data-paseo-markdown-tag="code"]')
      .filter({ hasText: "apply_patch" });
    await expect(inlineCode).toHaveAttribute("data-pmono", "");

    await selectStructuredClipboardFixture(page);
    await copySelection(page);

    const clipboard = await readRichClipboard(page);
    expect(clipboard.plainText).toBe(EXPECTED_WHOLE_SELECTION_MARKDOWN);
    expect(clipboard.html).not.toContain("<ul>");
    expect(clipboard.html).not.toContain("<li>");
    expect(clipboard.html).toContain("<div>- ");
    expect(clipboard.html).toContain(
      '<strong><a href="https://example.com/issues/1">First issue</a></strong>',
    );
    expect(clipboard.html).toContain("<code>apply_patch</code>");
    expect(clipboard.html).toContain("<div>5. Fifth item</div>");
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
    expect(clipboard.html).toContain(
      '<a href="file:///tmp/paseo%20notes.md#L4">workspace file</a>',
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

    await doubleClickAssistantMarkdownText(page, "code", "apply_patch");
    await copySelection(page);

    const doubleClickedCodeClipboard = await readRichClipboard(page);
    expect(doubleClickedCodeClipboard.plainText).toBe("apply_patch");
    expect(doubleClickedCodeClipboard.html).not.toContain("<code>");

    await doubleClickAssistantMarkdownText(page, "strong", "strong prose");
    await copySelection(page);

    const doubleClickedBoldClipboard = await readRichClipboard(page);
    expect(doubleClickedBoldClipboard.plainText).toBe("strong");
    expect(doubleClickedBoldClipboard.html).not.toContain("<strong>");

    await selectAssistantTextRange(
      page,
      "P1 — High-value UI behavior",
      "Smoke with an older saved Fabel/model alias and with daemon/client version drift.",
    );
    await copySelection(page);

    const headingAndListClipboard = await readRichClipboard(page);
    expect(headingAndListClipboard.plainText).toBe(
      [
        "P1 — High-value UI behavior",
        "===========================",
        "",
        "5. Claude model and thinking preferences",
        "    - Switch Claude models and confirm each model retains its own thinking choice.",
        "    - Cover new-workspace drafts, queued launches, schedules, and editing existing schedules.",
        "    - Confirm Opus 5 exposes the Fast toggle.",
        "    - Smoke with an older saved Fabel/model alias and with daemon/client version drift.",
      ].join("\n"),
    );
    expect(headingAndListClipboard.html).toMatch(
      /<h1>P1 — High-value UI behavior<\/h1>\s*<div>5\. Claude model and thinking preferences\s*<\/div><div>- Switch Claude models/,
    );

    await selectAssistantText(page, "First");
    await copySelection(page);

    const partialClipboard = await readRichClipboard(page);
    expect(partialClipboard.plainText).toBe("First");
    expect(partialClipboard.html).toContain("<p>First</p>");

    await selectAssistantTextRange(page, "Direct matches:", "repeated sandbox setup.");
    await copySelection(page);

    const paragraphAndListClipboard = await readRichClipboard(page);
    expect(paragraphAndListClipboard.plainText).toBe(
      [
        "Direct matches:",
        "",
        "Formatted **strong prose**, _emphasized prose_, and ~~struck prose~~.",
        "",
        "- **[First issue](https://example.com/issues/1)**: exact `apply_patch` failure.",
        "- [Second issue](https://example.com/issues/2): repeated sandbox setup.",
      ].join("\n"),
    );
    expect(paragraphAndListClipboard.html).not.toContain("<ul>");
    expect(paragraphAndListClipboard.html).not.toContain("<li>");
    expect(paragraphAndListClipboard.html).toContain(
      '<div>- <strong><a href="https://example.com/issues/1">First issue</a></strong>',
    );

    await selectAssistantListItemFromMarker(page, "ul", "First issue", "failure.");
    await copySelection(page);

    const draggedBulletClipboard = await readRichClipboard(page);
    expect(draggedBulletClipboard.plainText).toBe(
      "- **[First issue](https://example.com/issues/1)**: exact `apply_patch` failure.",
    );
    expect(draggedBulletClipboard.html).toContain(
      '<div>- <strong><a href="https://example.com/issues/1">First issue</a></strong>',
    );

    await selectAssistantListItemFromMarker(page, "ol", "Sixth item", "Sixth item");
    await copySelection(page);

    const draggedNumberClipboard = await readRichClipboard(page);
    expect(draggedNumberClipboard.plainText).toBe("6. Sixth item");
    expect(draggedNumberClipboard.html).toContain("<div>6. Sixth item</div>");

    await selectAssistantText(page, "docs");
    await copySelection(page);

    const titledLinkClipboard = await readRichClipboard(page);
    expect(titledLinkClipboard.plainText).toBe("docs");
    expect(titledLinkClipboard.html).not.toContain("<a ");

    await selectAssistantText(page, "https://autolink.example.com");
    await copySelection(page);

    const autolinkClipboard = await readRichClipboard(page);
    expect(autolinkClipboard.plainText).toBe("https://autolink.example.com");

    await selectAssistantText(page, "workspace file");
    await copySelection(page);

    const fileLinkClipboard = await readRichClipboard(page);
    expect(fileLinkClipboard.plainText).toBe("workspace file");
    expect(fileLinkClipboard.html).not.toContain("<a ");

    await selectAssistantTextRange(page, "Seventh item", "Eighth item");
    await copySelection(page);

    const midListClipboard = await readRichClipboard(page);
    expect(midListClipboard.plainText).toBe("Seventh item\n\n8. Eighth item");
    expect(midListClipboard.html).toContain("<div>8. Eighth item</div>");

    await selectAssistantTextRange(page, "Inner eight", "Inner nine");
    await copySelection(page);

    const nestedListClipboard = await readRichClipboard(page);
    expect(nestedListClipboard.plainText).toBe("Inner eight\n\n9. Inner nine");
    expect(nestedListClipboard.html).toContain("<div>9. Inner nine</div>");

    await selectAssistantTextRange(page, "Seventh item", "Nested list:");
    await copySelection(page);

    const crossBlockClipboard = await readRichClipboard(page);
    expect(crossBlockClipboard.plainText).toBe("Seventh item\n\n8. Eighth item\n\nNested list:");
    expect(crossBlockClipboard.html).toContain("<div>8. Eighth item</div>");

    await selectAssistantText(page, "Current");
    await copySelection(page);

    const partialTableClipboard = await readRichClipboard(page);
    expect(partialTableClipboard.plainText).toBe("Current");
    expect(partialTableClipboard.html).toContain("<p>Current</p>");
    expect(partialTableClipboard.html).not.toContain("&lt;table");

    await selectAssistantTextRange(page, "Right", "ready");
    await copySelection(page);

    const columnSliceClipboard = await readRichClipboard(page);
    expect(columnSliceClipboard.plainText).toContain("ready");
    expect(columnSliceClipboard.html).not.toContain("<table>");
    expect(columnSliceClipboard.html).toContain("ready");
    expect(columnSliceClipboard.html).toContain("<s>obsolete</s>");

    // A partial selection loses its `pre` wrapper, so the code reaches Turndown as
    // prose unless it is diverted first: the line break and the indentation go, and
    // Markdown-significant characters get escaped.
    await selectAssistantAcrossCodeLines(page, "const", "return");
    await copySelection(page);

    const codeLinesClipboard = await readRichClipboard(page);
    expect(codeLinesClipboard.plainText).toBe('const answer = "yes";\n  return');
    expect(codeLinesClipboard.html).toContain('<pre><code class="language-typescript">');

    // Selecting inside code expresses an intent to copy code, even when the selection
    // contains every character in the block.
    await selectAssistantElement(
      page,
      '[data-paseo-markdown-language="typescript"] [data-paseo-markdown-tag="code"]',
    );
    await copySelection(page);

    const completeCodeClipboard = await readRichClipboard(page);
    expect(completeCodeClipboard.plainText).toBe('const answer = "yes";\n  return answer;');

    // Crossing the block boundary expresses an intent to carry its Markdown structure.
    await selectAssistantAcrossCodeLines(page, "const", "After code.");
    await copySelection(page);

    const crossedCodeClipboard = await readRichClipboard(page);
    expect(crossedCodeClipboard.plainText).toBe(
      '```typescript\nconst answer = "yes";\n  return answer;\n```\n\nAfter code.',
    );

    // Selecting a whole line runs off its end into the newline node. A trailing
    // newline auto-executes the line when it is pasted into a terminal.
    await selectAssistantAcrossCodeLines(page, "const", "  ");
    await copySelection(page);

    expect((await readRichClipboard(page)).plainText).toBe('const answer = "yes";');

    // The block's own Copy button had the same hazard: a Markdown fence body ends in
    // a newline, and the button copied it raw.
    const typescriptFence = assistantMessage.locator('[data-paseo-markdown-language="typescript"]');
    // The button is opacity 0 / pointerEvents none until the fence is hovered.
    await typescriptFence.hover();
    await typescriptFence.locator("[data-paseo-markdown-ignore]").click();

    expect(await readPlainClipboard(page)).toBe('const answer = "yes";\n  return answer;');

    // A blank line before the closing fence leaves the body ending in two newlines,
    // so stripping only the terminal one still hands the terminal an executable line.
    const bashFence = assistantMessage.locator('[data-paseo-markdown-language="bash"]');
    await bashFence.hover();
    await bashFence.locator("[data-paseo-markdown-ignore]").click();

    expect(await readPlainClipboard(page)).toBe("echo trailing");
  } finally {
    await agent.cleanup();
  }
});
