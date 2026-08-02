import type { BrowserContext } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const ASSISTANT_MARKDOWN = [
  "Direct matches:",
  "",
  "- [First issue](https://example.com/issues/1): exact `apply_patch` failure.",
  "- [Second issue](https://example.com/issues/2): repeated sandbox setup.",
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
    expect(clipboard.html).toContain('<a href="https://example.com/issues/1">First issue</a>');
    expect(clipboard.html).toContain("<code>apply_patch</code>");
  } finally {
    await agent.cleanup();
  }
});
