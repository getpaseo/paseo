import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { openFileExplorer, openFileFromExplorer } from "../support/helpers/file-explorer";

// Switching a file tab between Preview and Source returns to where each view was left.

const sections = Array.from({ length: 200 }, (_, index) => index);
const LONG_MARKDOWN = sections.map((i) => `## Section ${i}\n\nParagraph ${i}.\n`).join("\n");
const LONG_HTML = `<!doctype html><html><body>${sections
  .map((i) => `<h2>Section ${i}</h2><p>Paragraph ${i}</p>`)
  .join("")}</body></html>`;

type FileView = "markdown preview" | "html preview" | "source";

function htmlPreviewFrame(page: Page) {
  const frame = page.frames().find((candidate) => candidate.url().startsWith("data:text/html"));
  if (!frame) throw new Error("The HTML preview frame is not loaded.");
  return frame;
}

/**
 * Moves the view's visible scroller to `offset` when given, and returns its offset. The
 * scroller is Markdown's scroll view, CodeMirror's scroller, or the HTML page itself.
 */
async function viewScroll(page: Page, view: FileView, offset?: number): Promise<number> {
  if (view === "html preview") {
    return htmlPreviewFrame(page).evaluate((target) => {
      if (target !== undefined) window.scrollTo(0, target);
      return window.scrollY;
    }, offset);
  }
  return page.evaluate(
    (input) => {
      const visible = (element: HTMLElement) => element.offsetParent !== null;
      let scroller: HTMLElement | null;
      if (input.view === "source") {
        scroller =
          [...document.querySelectorAll<HTMLElement>(".cm-scroller")].find(visible) ?? null;
      } else {
        scroller =
          [
            ...document.querySelectorAll<HTMLElement>('[data-testid="markdown-preview-frame"]'),
          ].find(visible) ?? null;
        while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 10)) {
          scroller = scroller.parentElement;
        }
      }
      if (!scroller) throw new Error(`No visible scroller for the ${input.view}.`);
      if (input.offset !== undefined) scroller.scrollTop = input.offset;
      return scroller.scrollTop;
    },
    { view, offset },
  );
}

async function openLongFile(
  page: Page,
  withWorkspace: (options?: { prefix?: string }) => Promise<{
    repoPath: string;
    navigateTo(): Promise<void>;
  }>,
  name: string,
  content: string,
): Promise<void> {
  const workspace = await withWorkspace({ prefix: "file-view-scroll-" });
  await writeFile(path.join(workspace.repoPath, name), content);
  await workspace.navigateTo();
  await openFileExplorer(page);
  await openFileFromExplorer(page, name);
  await expect(page.getByTestId("file-mode-preview")).toBeVisible({ timeout: 30_000 });
}

async function showView(page: Page, view: "preview" | "source"): Promise<void> {
  await page.getByTestId(`file-mode-${view}`).click();
}

/** Scrolls the view past the first screen and returns where it settled. */
async function scrollDown(page: Page, view: FileView): Promise<number> {
  await expect(async () => {
    expect(await viewScroll(page, view, 1200)).toBeGreaterThan(1000);
  }).toPass({ timeout: 15_000 });
  // CodeMirror can adjust the offset once after a scroll; read it after that settles.
  await page.waitForTimeout(300);
  return viewScroll(page, view);
}

async function expectOffsetKept(page: Page, view: FileView, offset: number): Promise<void> {
  await expect.poll(() => viewScroll(page, view), { timeout: 5_000 }).toBe(offset);
}

test("Markdown preview keeps its scroll offset after showing Source", async ({
  page,
  withWorkspace,
}) => {
  await openLongFile(page, withWorkspace, "long.md", LONG_MARKDOWN);
  const offset = await scrollDown(page, "markdown preview");

  await showView(page, "source");
  await expect(page.getByTestId("file-source-editor")).toBeVisible();
  await showView(page, "preview");

  await expectOffsetKept(page, "markdown preview", offset);
});

test("HTML preview keeps its scroll offset after showing Source", async ({
  page,
  withWorkspace,
}) => {
  await openLongFile(page, withWorkspace, "long.html", LONG_HTML);
  const offset = await scrollDown(page, "html preview");

  await showView(page, "source");
  await expect(page.getByTestId("file-source-editor")).toBeVisible();
  await showView(page, "preview");

  await expectOffsetKept(page, "html preview", offset);
});

test("Source keeps its scroll offset after showing Preview", async ({ page, withWorkspace }) => {
  await openLongFile(page, withWorkspace, "long.md", LONG_MARKDOWN);
  await showView(page, "source");
  const offset = await scrollDown(page, "source");

  await showView(page, "preview");
  await expect(page.getByTestId("markdown-preview-frame")).toBeVisible();
  await showView(page, "source");

  await expectOffsetKept(page, "source", offset);
});
