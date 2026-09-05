import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { expectFileTabOpen, openFileExplorer, openFileFromExplorer } from "./file-explorer";
import { openAgentRoute, seedMockAgentWorkspace, type MockAgentWorkspace } from "./mock-agent";
import type { TerminalE2EHarness } from "./terminal-dsl";
import { waitForTerminalContent } from "./terminal-perf";
import {
  expectTimelinePromptNotMounted,
  expectTimelinePromptVisible,
  openAgentTimeline,
  scrollTimelineToNewestLoadedEdge,
  scrollTimelineUntilOlderHistoryIsReachable,
  type LongTimelineAgent,
} from "./timeline-pagination";
import type { WithWorkspace } from "./with-workspace";

/** A file the find spec searches, and the workspace it is written into. */
export interface FindFileFixture {
  prefix: string;
  file: string;
  content: string;
}

export interface HighlightCounts {
  plain: number;
  active: number;
}

function findBar(page: Page): Locator {
  return page.getByTestId("find-bar").filter({ visible: true }).first();
}

function findInput(page: Page): Locator {
  return page.getByTestId("find-bar-input").filter({ visible: true }).first();
}

function findCount(page: Page): Locator {
  return page.getByTestId("find-bar-count").filter({ visible: true }).first();
}

function sourceEditor(page: Page): Locator {
  return page.getByTestId("file-source-editor").filter({ visible: true }).first();
}

export async function openFind(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+f");
  await expect(findBar(page)).toBeVisible();
  // The bar focuses its input from an effect, so typing before this settles would be
  // overwritten by the prefill that same effect applies.
  await expect(findInput(page)).toBeFocused();
}

/** Opens the bar and types `query` into it. */
export async function findFor(page: Page, query: string): Promise<void> {
  await openFind(page);
  await findInput(page).fill(query);
}

export async function expectFindCount(
  page: Page,
  label: string | RegExp,
  options?: { timeout?: number },
): Promise<void> {
  await expect(findCount(page)).toHaveText(label, options);
}

export async function expectFindQuery(page: Page, query: string): Promise<void> {
  await expect(findInput(page)).toHaveValue(query);
}

export async function goToNextMatch(page: Page): Promise<void> {
  await page.keyboard.press("Enter");
}

export async function goToPreviousMatch(page: Page): Promise<void> {
  await page.keyboard.press("Shift+Enter");
}

export async function goToNextMatchWithShortcut(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+g");
}

export async function goToPreviousMatchWithShortcut(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+Shift+g");
}

export async function closeFind(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expectFindClosed(page);
}

export async function closeFindWithButton(page: Page): Promise<void> {
  await page.getByTestId("find-bar-close").filter({ visible: true }).first().click();
  await expectFindClosed(page);
}

export async function expectFindClosed(page: Page): Promise<void> {
  await expect(page.getByTestId("find-bar")).toHaveCount(0);
}

/** The document-level CSS Custom Highlight registry the DOM engines paint through. */
async function highlightSize(page: Page, name: string): Promise<number> {
  return page.evaluate((highlightName) => CSS.highlights.get(highlightName)?.size ?? 0, name);
}

/**
 * The active range is painted by the second highlight, so it is excluded from the
 * plain-match one rather than stacked under it.
 */
export async function expectHighlightedMatches(page: Page, counts: HighlightCounts): Promise<void> {
  await expect.poll(() => highlightSize(page, "paseo-find-match")).toBe(counts.plain);
  await expect.poll(() => highlightSize(page, "paseo-find-match-active")).toBe(counts.active);
}

/** CodeMirror marks its matches with classes instead; the active one carries its own. */
export async function expectSourceMarks(page: Page, counts: HighlightCounts): Promise<void> {
  await expect(sourceEditor(page).locator(".cm-paseoFindMatch")).toHaveCount(counts.plain);
  await expect(sourceEditor(page).locator(".cm-paseoFindMatchActive")).toHaveCount(counts.active);
}

export async function expectActiveSourceLine(page: Page, text: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelector(".cm-paseoFindMatchActive")?.closest(".cm-line")?.textContent ??
          null,
      ),
    )
    .toBe(text);
}

/**
 * Seeds a mock agent whose single assistant message renders `markdown`. Pair with
 * {@link openTranscript}; the caller owns the returned cleanup.
 */
export async function seedFindTranscript(markdown: string): Promise<MockAgentWorkspace> {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "find-transcript-",
    title: "Find in transcript",
    initialPrompt: "Render the find fixture.",
    featureValues: { mockAssistantResponse: markdown },
  });
  try {
    await agent.client.waitForAgentUpsert(
      agent.agentId,
      (snapshot) => snapshot.status === "idle",
      30_000,
    );
  } catch (error) {
    await agent.cleanup();
    throw error;
  }
  return agent;
}

export async function openTranscript(
  page: Page,
  agent: MockAgentWorkspace,
  renderedText: string,
): Promise<void> {
  await openAgentRoute(page, agent);
  await expect(page.getByTestId("assistant-message").filter({ hasText: renderedText })).toBeVisible(
    { timeout: 30_000 },
  );
}

/**
 * Loads every turn and returns to the newest edge, leaving `prompt` inside the loaded
 * window but virtualized out of the DOM — the state find has to recover from.
 */
export async function openTimelineWithPromptVirtualized(
  page: Page,
  agent: LongTimelineAgent,
  prompt: string,
): Promise<void> {
  await openAgentTimeline(page, agent);
  await expectTimelinePromptVisible(page, agent.newestPrompt);
  await scrollTimelineUntilOlderHistoryIsReachable(page, agent.oldestPrompt);
  await scrollTimelineToNewestLoadedEdge(page);
  await expectTimelinePromptVisible(page, agent.newestPrompt);
  await expectTimelinePromptNotMounted(page, prompt);
}

export async function expectRowInsideTimelineViewport(page: Page, prompt: string): Promise<void> {
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

/** Runs `command` at a deterministic prompt and waits until `settledText` is on screen. */
export async function runInTerminal(
  page: Page,
  harness: TerminalE2EHarness,
  input: { command: string; settledText: string },
): Promise<void> {
  await harness.setupPrompt(page);
  await harness.terminalSurface(page).first().pressSequentially(input.command, { delay: 0 });
  await waitForTerminalContent(page, (text) => text.includes(input.settledText), 15_000);
}

export async function expectTerminalFindMarks(page: Page): Promise<void> {
  await expect(
    page.locator('[data-testid="terminal-surface"] .xterm-find-result-decoration'),
  ).not.toHaveCount(0);
}

/** Closing the bar hands focus back to the element it took it from — xterm's textarea. */
export async function expectTerminalFocused(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.className ?? ""))
    .toContain("xterm-helper-textarea");
}

/**
 * The total the bar reports while sitting on the first match. The terminal's total
 * depends on how the shell echoed the command, so the test reads it instead of naming it.
 */
export async function readMatchTotalOfAtLeast(page: Page, minimum: number): Promise<number> {
  await expectFindCount(page, /^1 of \d+$/);
  const label = await findCount(page).innerText();
  const total = Number(label.split(" of ")[1]);
  expect(total).toBeGreaterThanOrEqual(minimum);
  return total;
}

async function openFileInWorkspace(
  page: Page,
  withWorkspace: WithWorkspace,
  fixture: FindFileFixture,
): Promise<void> {
  const workspace = await withWorkspace({ prefix: fixture.prefix });
  await writeFile(path.join(workspace.repoPath, fixture.file), fixture.content, "utf8");
  await workspace.navigateTo();
  await openFileExplorer(page);
  await openFileFromExplorer(page, fixture.file);
  await expectFileTabOpen(page, fixture.file);
}

/** A file with no rendered mode opens straight into its source view. */
export async function openWorkspaceSourceFile(
  page: Page,
  withWorkspace: WithWorkspace,
  fixture: FindFileFixture,
): Promise<void> {
  await openFileInWorkspace(page, withWorkspace, fixture);
  await focusSourceStart(page);
}

/** Markdown and HTML open in their rendered preview, with a toggle back to source. */
export async function openWorkspaceRenderedFile(
  page: Page,
  withWorkspace: WithWorkspace,
  fixture: FindFileFixture,
): Promise<void> {
  await openFileInWorkspace(page, withWorkspace, fixture);
}

export async function showFileSource(page: Page): Promise<void> {
  await selectFileView(page, "Source");
  await focusSourceStart(page);
}

export async function showFilePreview(page: Page): Promise<void> {
  await selectFileView(page, "Preview");
  // The mode switch is only real once CodeMirror is gone: that is what takes the
  // engine behind the bar with it.
  await expect(page.getByTestId("file-source-editor")).toHaveCount(0);
}

async function selectFileView(page: Page, view: "Preview" | "Source"): Promise<void> {
  const option = page
    .getByTestId("file-panel-bar")
    .getByRole("button", { name: view, exact: true });
  await option.click();
  await expect(option).toHaveAttribute("aria-selected", "true");
}

/** Places the caret at the document start so the first match is deterministic. */
async function focusSourceStart(page: Page): Promise<void> {
  const content = sourceEditor(page).locator(".cm-content");
  await content.click();
  await content.press("ControlOrMeta+Home");
  await expect(page.getByLabel("Line 1, column 1")).toBeVisible();
}
