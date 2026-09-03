import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import {
  openFileExplorer,
  openFileFromExplorer,
  expectFileTabOpen,
} from "../support/helpers/file-explorer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { TerminalE2EHarness, withTerminalInApp } from "../support/helpers/terminal-dsl";
import { waitForTerminalContent } from "../support/helpers/terminal-perf";
import {
  expectTimelinePromptNotMounted,
  expectTimelinePromptVisible,
  openAgentTimeline,
  scrollTimelineToNewestLoadedEdge,
  scrollTimelineUntilOlderHistoryIsReachable,
  seedLongMockAgentTimeline,
} from "../support/helpers/timeline-pagination";

/**
 * Every occurrence of "lantern" the transcript paints, and only those: the bold
 * markers, the link URL and the fence delimiters are markdown syntax the renderer
 * drops, so a search over the raw text would count five.
 */
const TRANSCRIPT_MARKDOWN = [
  "The **lantern** stays bold.",
  "",
  "- A [lantern guide](https://example.com/lantern-notes) points elsewhere.",
  "- Plain item without the word.",
  "",
  "```ts",
  'const lantern = "lantern";',
  "```",
].join("\n");

const TRANSCRIPT_MATCH_COUNT = 4;

const SOURCE_FILE = "find-target.ts";
const SOURCE_CONTENT = [
  'const alpha = "needle one";',
  "const beta = 2;",
  'const gamma = "needle two";',
  "const delta = 4;",
  'const epsilon = "needle three";',
  "",
].join("\n");

const MARKDOWN_FILE = "find-notes.md";
const MARKDOWN_CONTENT = [
  "# Beacon notes",
  "",
  "The beacon repeats: beacon.",
  "",
  "- beacon item",
  "",
].join("\n");

/** The terminal token never appears in the command line that produces it. */
const TERMINAL_TOKEN = "zeb-";
const TERMINAL_COMMAND = `tok=zeb; printf '%s\\n' "$tok-1" "$tok-2" "$tok-3"\n`;

function findBar(page: Page) {
  return page.getByTestId("find-bar").filter({ visible: true }).first();
}

function findInput(page: Page) {
  return page.getByTestId("find-bar-input").filter({ visible: true }).first();
}

function findCount(page: Page) {
  return page.getByTestId("find-bar-count").filter({ visible: true }).first();
}

async function openFindBar(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+f");
  await expect(findBar(page)).toBeVisible();
  // The bar focuses its input from an effect, so typing before this settles would be
  // overwritten by the prefill that same effect applies.
  await expect(findInput(page)).toBeFocused();
}

async function typeFindQuery(page: Page, query: string): Promise<void> {
  await findInput(page).fill(query);
}

async function closeFindBar(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("find-bar")).toHaveCount(0);
}

/** The document-level CSS Custom Highlight registry the DOM engines paint through. */
async function highlightSize(page: Page, name: string): Promise<number> {
  return page.evaluate((highlightName) => CSS.highlights.get(highlightName)?.size ?? 0, name);
}

async function activeElementClassName(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.className ?? "");
}

/** Closing the bar hands focus back to the element it took it from — xterm's textarea. */
async function expectTerminalTextareaFocused(page: Page): Promise<void> {
  await expect.poll(() => activeElementClassName(page)).toContain("xterm-helper-textarea");
}

function hasLastTerminalLine(text: string): boolean {
  return text.includes("zeb-3");
}

async function readMatchTotal(page: Page): Promise<number> {
  const label = await findCount(page).innerText();
  const total = Number(label.split(" of ")[1]);
  expect(Number.isFinite(total)).toBe(true);
  return total;
}

function sourceEditor(page: Page) {
  return page.getByTestId("file-source-editor").filter({ visible: true }).first();
}

async function selectFileView(page: Page, view: "Preview" | "Source"): Promise<void> {
  const option = page
    .getByTestId("file-panel-bar")
    .getByRole("button", { name: view, exact: true });
  await option.click();
  await expect(option).toHaveAttribute("aria-selected", "true");
}

/** Places the caret at the document start so the first match is deterministic. */
async function focusEditorAtStart(page: Page): Promise<void> {
  const content = sourceEditor(page).locator(".cm-content");
  await content.click();
  await content.press("ControlOrMeta+Home");
  await expect(page.getByLabel("Line 1, column 1")).toBeVisible();
}

async function activeMatchLineText(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document.querySelector(".cm-paseoFindMatchActive")?.closest(".cm-line")?.textContent ?? null,
  );
}

async function expectPromptInsideTimelineViewport(page: Page, prompt: string): Promise<void> {
  const timeline = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  const row = timeline.locator("[data-history-row-id]").filter({ hasText: prompt }).first();
  await expect
    .poll(async () => {
      const [timelineBox, rowBox] = await Promise.all([timeline.boundingBox(), row.boundingBox()]);
      if (!timelineBox || !rowBox) return false;
      return (
        rowBox.y >= timelineBox.y - 1 &&
        rowBox.y + rowBox.height <= timelineBox.y + timelineBox.height + 1
      );
    })
    .toBe(true);
}

test.describe("find in pane", () => {
  test("searches the rendered transcript and steps through its matches", async ({ page }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "find-transcript-",
      title: "Find in transcript",
      initialPrompt: "Render the find fixture.",
      featureValues: { mockAssistantResponse: TRANSCRIPT_MARKDOWN },
    });

    try {
      await agent.client.waitForAgentUpsert(
        agent.agentId,
        (snapshot) => snapshot.status === "idle",
        30_000,
      );
      await openAgentRoute(page, agent);
      await expect(
        page.getByTestId("assistant-message").filter({ hasText: "stays bold" }),
      ).toBeVisible({ timeout: 30_000 });

      await openFindBar(page);
      await typeFindQuery(page, "lantern");
      await expect(findCount(page)).toHaveText(`1 of ${TRANSCRIPT_MATCH_COUNT}`);

      await page.keyboard.press("Enter");
      await expect(findCount(page)).toHaveText(`2 of ${TRANSCRIPT_MATCH_COUNT}`);
      await page.keyboard.press("Shift+Enter");
      await expect(findCount(page)).toHaveText(`1 of ${TRANSCRIPT_MATCH_COUNT}`);

      await page.keyboard.press("ControlOrMeta+g");
      await expect(findCount(page)).toHaveText(`2 of ${TRANSCRIPT_MATCH_COUNT}`);
      await page.keyboard.press("ControlOrMeta+Shift+g");
      await expect(findCount(page)).toHaveText(`1 of ${TRANSCRIPT_MATCH_COUNT}`);

      // The active range is painted by the second highlight, so it is excluded from
      // the plain-match one rather than stacked under it.
      await expect
        .poll(() => highlightSize(page, "paseo-find-match"))
        .toBe(TRANSCRIPT_MATCH_COUNT - 1);
      await expect.poll(() => highlightSize(page, "paseo-find-match-active")).toBe(1);

      await closeFindBar(page);
      await expect.poll(() => highlightSize(page, "paseo-find-match")).toBe(0);
    } finally {
      await agent.cleanup();
    }
  });

  test("reveals a virtualized transcript row that holds the only match", async ({ page }) => {
    test.setTimeout(180_000);
    const agent = await seedLongMockAgentTimeline({ turns: 60 });

    try {
      await openAgentTimeline(page, agent);
      await expectTimelinePromptVisible(page, agent.newestPrompt);

      // Load every turn, then return to the newest edge so the old prompt is inside
      // the loaded window but virtualized out of the DOM.
      await scrollTimelineUntilOlderHistoryIsReachable(page, agent.oldestPrompt);
      await scrollTimelineToNewestLoadedEdge(page);
      await expectTimelinePromptVisible(page, agent.newestPrompt);

      const target = agent.prompts[3];
      await expectTimelinePromptNotMounted(page, target);

      await openFindBar(page);
      await typeFindQuery(page, "timeline-pagination-turn-3:");
      await expect(findCount(page)).toHaveText("1 of 1", { timeout: 30_000 });

      await expectTimelinePromptVisible(page, target);
      await expectPromptInsideTimelineViewport(page, target);

      await closeFindBar(page);
    } finally {
      await agent.cleanup();
    }
  });

  test("searches the terminal buffer and returns focus to it on close", async ({ page }) => {
    test.setTimeout(120_000);
    const harness = await TerminalE2EHarness.create({ tempPrefix: "find-terminal-" });

    try {
      await withTerminalInApp(page, harness, { name: "find-terminal" }, async () => {
        await harness.setupPrompt(page);

        const terminal = harness.terminalSurface(page).first();
        await terminal.pressSequentially(TERMINAL_COMMAND, { delay: 0 });
        await waitForTerminalContent(page, hasLastTerminalLine, 15_000);

        await openFindBar(page);
        await typeFindQuery(page, TERMINAL_TOKEN);
        await expect(findCount(page)).toHaveText(/^1 of \d+$/);

        const total = await readMatchTotal(page);
        expect(total).toBeGreaterThanOrEqual(2);
        await expect(
          page.locator('[data-testid="terminal-surface"] .xterm-find-result-decoration'),
        ).not.toHaveCount(0);

        await page.keyboard.press("Enter");
        await expect(findCount(page)).toHaveText(`2 of ${total}`);

        await closeFindBar(page);
        await expectTerminalTextareaFocused(page);
      });
    } finally {
      await harness.cleanup();
    }
  });

  test("marks and steps through the matches in a file's source", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(120_000);
    const workspace = await withWorkspace({ prefix: "find-file-source-" });
    await writeFile(path.join(workspace.repoPath, SOURCE_FILE), SOURCE_CONTENT, "utf8");
    await workspace.navigateTo();

    await openFileExplorer(page);
    await openFileFromExplorer(page, SOURCE_FILE);
    await expectFileTabOpen(page, SOURCE_FILE);
    await focusEditorAtStart(page);

    await openFindBar(page);
    await typeFindQuery(page, "needle");
    await expect(findCount(page)).toHaveText("1 of 3");
    // The active match carries its own class, so the plain marks are the other two.
    await expect(sourceEditor(page).locator(".cm-paseoFindMatch")).toHaveCount(2);
    await expect(sourceEditor(page).locator(".cm-paseoFindMatchActive")).toHaveCount(1);
    expect(await activeMatchLineText(page)).toBe('const alpha = "needle one";');

    await page.keyboard.press("Enter");
    await expect(findCount(page)).toHaveText("2 of 3");
    await expect.poll(() => activeMatchLineText(page)).toBe('const gamma = "needle two";');

    await closeFindBar(page);
    await expect(sourceEditor(page).locator(".cm-paseoFindMatch")).toHaveCount(0);
    await expect(sourceEditor(page).locator(".cm-paseoFindMatchActive")).toHaveCount(0);
  });

  test("carries a Markdown file's query from source into the preview", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(120_000);
    const workspace = await withWorkspace({ prefix: "find-file-markdown-" });
    await writeFile(path.join(workspace.repoPath, MARKDOWN_FILE), MARKDOWN_CONTENT, "utf8");
    await workspace.navigateTo();

    await openFileExplorer(page);
    await openFileFromExplorer(page, MARKDOWN_FILE);
    await expectFileTabOpen(page, MARKDOWN_FILE);
    await selectFileView(page, "Source");
    await focusEditorAtStart(page);

    await openFindBar(page);
    await typeFindQuery(page, "beacon");
    await expect(findCount(page)).toHaveText("1 of 4");

    // The mode switch swaps CodeMirror's engine for the rendered preview's DOM engine;
    // the typed query has to survive that.
    await selectFileView(page, "Preview");
    await expect(findBar(page)).toBeVisible();
    await expect(findInput(page)).toHaveValue("beacon");
    await expect(findCount(page)).toHaveText(/ of 4$/);
    await expect.poll(() => highlightSize(page, "paseo-find-match")).toBe(3);

    await page.getByTestId("find-bar-close").filter({ visible: true }).first().click();
    await expect(page.getByTestId("find-bar")).toHaveCount(0);
  });
});
