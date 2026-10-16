import { expect, test, type Page } from "../support/fixtures";
import {
  assistantMessageBlocks,
  selectAssistantTextRange,
} from "../support/helpers/assistant-selection";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";

const ASSISTANT_MARKDOWN = [
  "Intro paragraph with **bold words** and a [docs link](https://example.com/docs).",
  "",
  "- First point",
  "- Second point",
  "",
  "```ts",
  "const quoted = true;",
  "```",
  "",
  "Closing paragraph.",
].join("\n");

function composer(page: Page) {
  return page.getByRole("textbox", { name: "Message agent..." });
}

function quoteButton(page: Page) {
  return page.getByTestId("assistant-selection-quote-button");
}

function noteInput(page: Page) {
  return page.getByRole("textbox", { name: "Note on the quote" });
}

function quoted(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

async function openIdleAgent(page: Page, repoPrefix: string): Promise<MockAgentWorkspace> {
  const agent = await seedMockAgentWorkspace({
    repoPrefix,
    title: "Assistant selection quote",
    initialPrompt: "Render the quote fixture.",
    featureValues: { mockAssistantResponse: ASSISTANT_MARKDOWN },
  });
  await agent.client.waitForAgentUpsert(
    agent.agentId,
    (snapshot) => snapshot.status === "idle",
    30_000,
  );
  await openAgentRoute(page, agent);
  await expect(assistantMessageBlocks(page).getByText("Closing paragraph.")).toBeVisible();
  return agent;
}

test("quoting a selection puts it and the note into the composer without sending", async ({
  context,
  page,
}) => {
  const agent = await openIdleAgent(page, "assistant-selection-quote-");
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await composer(page).fill("Draft start");

    await selectAssistantTextRange(page, "Intro paragraph", "const quoted = true;");
    await expect(quoteButton(page)).toBeVisible();

    // Copy works as before while the button shows, and Quote reads the same Markdown.
    await page.keyboard.press("ControlOrMeta+c");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("**bold words**");
    expect(copied).toContain("[docs link](https://example.com/docs)");
    expect(copied).toContain("- First point\n- Second point");
    expect(copied).toContain("```ts\nconst quoted = true;\n```");

    await quoteButton(page).click();
    await expect(noteInput(page)).toBeFocused();
    await expect(page.getByText("Enter adds to the message", { exact: false })).toBeVisible();
    await expect(quoteButton(page)).toHaveCount(0);

    await page.keyboard.type("First line");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("second line");
    await page.keyboard.press("Enter");

    await expect(noteInput(page)).toHaveCount(0);
    await expect(composer(page)).toBeFocused();
    await expect(composer(page)).toHaveValue(
      `Draft start\n\n${quoted(copied)}\n\nFirst line\nsecond line`,
    );
    expect(
      await composer(page).evaluate(
        (element) =>
          element instanceof HTMLTextAreaElement &&
          element.selectionStart === element.value.length &&
          element.selectionEnd === element.value.length,
      ),
    ).toBe(true);

    // An empty note quotes alone and leaves a fresh paragraph to type into.
    await assistantMessageBlocks(page)
      .getByText("Closing paragraph.")
      .dblclick({ position: { x: 5, y: 5 } });
    await quoteButton(page).click();
    await expect(noteInput(page)).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(composer(page)).toHaveValue(
      `Draft start\n\n${quoted(copied)}\n\nFirst line\nsecond line\n\n> Closing\n\n`,
    );
    await expect(composer(page)).toBeFocused();

    // Nothing was sent: the only user message is the one that started the agent.
    await expect(page.getByText("First line", { exact: false })).toHaveCount(0);
  } finally {
    await agent.cleanup();
  }
});

test("Escape closes the note box and keeps the selection, then dismisses the button", async ({
  page,
}) => {
  const agent = await openIdleAgent(page, "assistant-selection-quote-escape-");
  try {
    await selectAssistantTextRange(page, "First point", "First point");
    await expect(quoteButton(page)).toBeVisible();

    // The button does not hold back the chat's find shortcut.
    await page.keyboard.press("ControlOrMeta+f");
    const find = page.getByRole("textbox", { name: "Find in pane", exact: true });
    await expect(find).toBeFocused();
    // Focusing find moves the selection out of the message, which takes the button away.
    await expect(quoteButton(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(find).toHaveCount(0);

    await selectAssistantTextRange(page, "First point", "First point");
    await quoteButton(page).click();
    await expect(noteInput(page)).toBeFocused();
    await page.keyboard.type("a note to drop");
    await page.keyboard.press("Escape");

    await expect(noteInput(page)).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe("First point");
    await expect(quoteButton(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(quoteButton(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("First point");
    await expect(composer(page)).toHaveValue("");
  } finally {
    await agent.cleanup();
  }
});

const STREAMED_RESPONSE = [
  "Early passage to quote.",
  "",
  "The reply keeps arriving one word at a time while the quote is written,",
  "so the message is still growing when the note goes into the composer.",
  "",
  "More words follow here to keep the stream open for a while longer.",
  "",
  "stream-end-sentinel",
].join("\n");

test("quoting works while the message is still streaming", async ({ page }) => {
  test.setTimeout(120_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "assistant-selection-quote-stream-",
    title: "Assistant selection quote stream",
    featureValues: {
      mockStreamingAssistantResponse: STREAMED_RESPONSE,
      mockStreamingAssistantIntervalMs: 300,
    },
  });
  try {
    await openAgentRoute(page, agent);
    await agent.client.sendAgentMessage(agent.agentId, "Stream a reply to quote");
    await expect(assistantMessageBlocks(page).getByText("Early passage to quote.")).toBeVisible({
      timeout: 30_000,
    });

    await selectAssistantTextRange(page, "Early passage", "to quote.");
    await quoteButton(page).click();
    await expect(noteInput(page)).toBeFocused();
    await page.keyboard.type("noted mid-stream");
    await page.keyboard.press("Enter");

    await expect(composer(page)).toHaveValue("> Early passage to quote.\n\nnoted mid-stream");
    await expect(page.getByText("stream-end-sentinel")).toHaveCount(0);
    await agent.client.waitForFinish(agent.agentId, 60_000);
  } finally {
    await agent.cleanup();
  }
});
