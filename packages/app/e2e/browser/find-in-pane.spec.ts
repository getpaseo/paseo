import { test } from "../support/fixtures";
import {
  closeFind,
  closeFindWithButton,
  expectActiveSourceLine,
  expectFindClosed,
  expectFindCount,
  expectFindQuery,
  expectHighlightedMatches,
  expectRowInsideTimelineViewport,
  expectSourceMarks,
  expectTerminalFindMarks,
  expectTerminalFocused,
  findFor,
  goToNextMatch,
  goToNextMatchWithShortcut,
  goToPreviousMatch,
  goToPreviousMatchWithShortcut,
  openFind,
  openTimelineWithPromptVirtualized,
  openTranscript,
  openWorkspaceRenderedFile,
  openWorkspaceSourceFile,
  readMatchTotalOfAtLeast,
  runInTerminal,
  seedFindTranscript,
  showFilePreview,
  showFileSource,
} from "../support/helpers/find-in-pane";
import { TerminalE2EHarness, withTerminalInApp } from "../support/helpers/terminal-dsl";
import {
  expectTimelinePromptVisible,
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

const SOURCE_FILE = {
  prefix: "find-file-source-",
  file: "find-target.ts",
  content: [
    'const alpha = "needle one";',
    "const beta = 2;",
    'const gamma = "needle two";',
    "const delta = 4;",
    'const epsilon = "needle three";',
    "",
  ].join("\n"),
};

const MARKDOWN_FILE = {
  prefix: "find-file-markdown-",
  file: "find-notes.md",
  content: ["# Beacon notes", "", "The beacon repeats: beacon.", "", "- beacon item", ""].join(
    "\n",
  ),
};

/** HTML renders into a sandboxed frame the pane cannot search, so Preview has no engine. */
const HTML_FILE = {
  prefix: "find-file-html-",
  file: "find-plan.html",
  content: [
    "<!doctype html>",
    "<html>",
    "  <body>",
    "    <p>The signal repeats: signal.</p>",
    "  </body>",
    "</html>",
    "",
  ].join("\n"),
};

/** The terminal token never appears in the command line that produces it. */
const TERMINAL_TOKEN = "zeb-";
const TERMINAL_COMMAND = `tok=zeb; printf '%s\\n' "$tok-1" "$tok-2" "$tok-3"\n`;

test.describe("find in pane", () => {
  test("searches the rendered transcript and steps through its matches", async ({ page }) => {
    const agent = await seedFindTranscript(TRANSCRIPT_MARKDOWN);

    try {
      await openTranscript(page, agent, "stays bold");

      await findFor(page, "lantern");
      await expectFindCount(page, `1 of ${TRANSCRIPT_MATCH_COUNT}`);

      await goToNextMatch(page);
      await expectFindCount(page, `2 of ${TRANSCRIPT_MATCH_COUNT}`);
      await goToPreviousMatch(page);
      await expectFindCount(page, `1 of ${TRANSCRIPT_MATCH_COUNT}`);

      await goToNextMatchWithShortcut(page);
      await expectFindCount(page, `2 of ${TRANSCRIPT_MATCH_COUNT}`);
      await goToPreviousMatchWithShortcut(page);
      await expectFindCount(page, `1 of ${TRANSCRIPT_MATCH_COUNT}`);

      await expectHighlightedMatches(page, { plain: TRANSCRIPT_MATCH_COUNT - 1, active: 1 });

      await closeFind(page);
      await expectHighlightedMatches(page, { plain: 0, active: 0 });
    } finally {
      await agent.cleanup();
    }
  });

  test("reveals a virtualized transcript row that holds the only match", async ({ page }) => {
    test.setTimeout(180_000);
    const agent = await seedLongMockAgentTimeline({ turns: 60 });
    const target = agent.prompts[3];

    try {
      await openTimelineWithPromptVirtualized(page, agent, target);

      await findFor(page, "timeline-pagination-turn-3:");
      await expectFindCount(page, "1 of 1", { timeout: 30_000 });

      await expectTimelinePromptVisible(page, target);
      await expectRowInsideTimelineViewport(page, target);

      await closeFind(page);
    } finally {
      await agent.cleanup();
    }
  });

  test("searches the terminal buffer and returns focus to it on close", async ({ page }) => {
    test.setTimeout(120_000);
    const harness = await TerminalE2EHarness.create({ tempPrefix: "find-terminal-" });

    try {
      await withTerminalInApp(page, harness, { name: "find-terminal" }, async () => {
        await runInTerminal(page, harness, {
          command: TERMINAL_COMMAND,
          settledText: "zeb-3",
        });

        await findFor(page, TERMINAL_TOKEN);
        const total = await readMatchTotalOfAtLeast(page, 2);
        await expectTerminalFindMarks(page);

        await goToNextMatch(page);
        await expectFindCount(page, `2 of ${total}`);

        await closeFind(page);
        await expectTerminalFocused(page);
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
    await openWorkspaceSourceFile(page, withWorkspace, SOURCE_FILE);

    await findFor(page, "needle");
    await expectFindCount(page, "1 of 3");
    await expectSourceMarks(page, { plain: 2, active: 1 });
    await expectActiveSourceLine(page, 'const alpha = "needle one";');

    await goToNextMatch(page);
    await expectFindCount(page, "2 of 3");
    await expectActiveSourceLine(page, 'const gamma = "needle two";');

    await closeFind(page);
    await expectSourceMarks(page, { plain: 0, active: 0 });
  });

  test("carries a Markdown file's query from source into the preview", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(120_000);
    await openWorkspaceRenderedFile(page, withWorkspace, MARKDOWN_FILE);
    await showFileSource(page);

    await findFor(page, "beacon");
    await expectFindCount(page, "1 of 4");

    // The mode switch swaps CodeMirror's engine for the rendered preview's DOM engine;
    // the typed query has to survive that.
    await showFilePreview(page);
    await expectFindQuery(page, "beacon");
    await expectFindCount(page, / of 4$/);
    await expectHighlightedMatches(page, { plain: 3, active: 1 });

    await closeFindWithButton(page);
  });

  test("closes the find bar when a file mode stops being searchable", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(120_000);
    await openWorkspaceRenderedFile(page, withWorkspace, HTML_FILE);
    await showFileSource(page);

    await findFor(page, "signal");
    await expectFindCount(page, "1 of 2");

    // Nothing in the HTML preview is searchable, so a bar left open over it would
    // answer neither Enter nor Cmd+G.
    await showFilePreview(page);
    await expectFindClosed(page);

    await showFileSource(page);
    await openFind(page);
    await expectFindCount(page, "1 of 2");
  });
});
