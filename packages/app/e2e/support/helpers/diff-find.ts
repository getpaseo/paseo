import { readFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  dragExactAddedText,
  readSelectionPaintSamples,
  type DiffPaintSamples,
  type DiffTextOffsets,
} from "./diff-source";

interface MatchCycle {
  next: string;
  previous: string;
}

/** User-level Find actions shared by the diff review scenarios. */
export function diffFind(page: Page) {
  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
  const scroller = panel.getByTestId("git-diff-scroll");
  const widget = panel.getByTestId("diff-find");
  const query = widget.getByRole("textbox");
  const status = widget.getByRole("status");

  async function focus() {
    // The tab's leading edge avoids its hover-only close action. Focusing the
    // scroll surface afterward preserves a canvas selection and folded files.
    await page
      .getByTestId("workspace-tab-working_diff")
      .filter({ visible: true })
      .first()
      .click({ position: { x: 12, y: 13 } });
    await scroller.focus();
  }
  async function open() {
    await page.keyboard.press("ControlOrMeta+f");
    await expect(query).toBeFocused();
  }
  async function changeQuery(text: string, position: string) {
    await test.step(`Find ${JSON.stringify(text)}: ${position}`, async () => {
      await query.fill(text);
      await expect(status).toHaveText(position);
    });
  }
  async function find(text: string, position: string) {
    await focus();
    await open();
    await changeQuery(text, position);
  }
  async function expectSingleMatch(filePath: string) {
    await test.step(`Reveal the match in ${filePath}`, async () => {
      await expect(status).toHaveText("1 of 1", { timeout: 30_000 });
      await expect(widget.getByTestId("diff-find-active-file")).toHaveText(filePath);
    });
  }
  async function findSingleMatch(text: string, filePath: string) {
    await find(text, "1 of 1");
    await expectSingleMatch(filePath);
  }
  async function close() {
    await query.press("Escape");
    await expect(widget).toHaveCount(0);
    await expect(scroller).toBeFocused();
  }

  return {
    find,
    findSingleMatch,
    changeQuery,
    expectSingleMatch,
    close,
    async rememberAppearance() {
      await focus();
      return readSelectionPaintSamples(page);
    },
    async expectHighlightedSource(original: DiffPaintSamples) {
      await test.step("Highlight matches without painting the gutter", async () => {
        await expect
          .poll(async () => (await readSelectionPaintSamples(page)).code)
          .not.toEqual(original.code);
        expect((await readSelectionPaintSamples(page)).gutter).toEqual(original.gutter);
      });
    },
    async cycleMatches(positions: MatchCycle) {
      await test.step("Navigate forward and backward through matches", async () => {
        await query.press("Enter");
        await expect(status).toHaveText(positions.next);
        await query.press("Shift+Enter");
        await expect(status).toHaveText(positions.previous);
      });
    },
    async expectClearedHighlight(text: string, original: DiffPaintSamples) {
      await changeQuery(text, "No matches");
      await expect
        .poll(async () => (await readSelectionPaintSamples(page)).code)
        .toEqual(original.code);
    },
    async selectText(offsets: DiffTextOffsets) {
      await dragExactAddedText(page, offsets);
    },
    async closeAndCopySelection(expected: string) {
      await test.step("Close Find and copy the original mouse selection", async () => {
        await close();
        await page.evaluate(() => navigator.clipboard.writeText(""));
        await page.keyboard.press("ControlOrMeta+C");
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
      });
    },
    async collapseFiles() {
      await panel.getByTestId("changes-toggle-collapse-all").click();
    },
    async expectRevealedFile(filePath: string) {
      await test.step(`Expand and reveal ${filePath}`, async () => {
        await expectSingleMatch(filePath);
        const header = panel
          .locator(`[data-diff-header-path="${filePath}"]`)
          .getByTestId(/^diff-file-\d+$/);
        await expect(header.getByTestId(/^diff-file-\d+-toggle$/)).toHaveAttribute(
          "aria-expanded",
          "true",
        );
        await expect(header).toBeVisible();
        await expect
          .poll(() => scroller.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(0);
      });
    },
    async switchToSplit(position: string) {
      await panel.getByTestId("changes-toggle-layout").click();
      await expect(status).toHaveText(position);
    },
    async wrapLines(position: string) {
      await panel.getByTestId("changes-toggle-wrap-lines").click();
      await expect(status).toHaveText(position);
      await expect(panel.getByTestId(/^diff-file-\d+-horizontal-scroll$/)).toHaveCount(0);
    },
    async expectHorizontalReveal() {
      await expect
        .poll(() =>
          panel
            .getByTestId("diff-file-0-horizontal-scroll")
            .evaluate((element) => element.scrollLeft),
        )
        .toBeGreaterThan(500);
    },
    async expectClosed() {
      await expect(widget).toHaveCount(0);
    },
    async expectInactiveQuery(text: string, position: string) {
      await expect(query).not.toBeFocused();
      await expect(query).toHaveValue(text);
      await expect(status).toHaveText(position);
    },
    async refocus() {
      const text = await query.inputValue();
      await focus();
      await open();
      await expect(query).toHaveValue(text);
    },
    async expectNoMatches() {
      await expect(status).toHaveText("No matches", { timeout: 30_000 });
    },
    async capture(testInfo: TestInfo, name: string) {
      await testInfo.attach(name, {
        body: await page.screenshot({ path: testInfo.outputPath(`${name}.png`) }),
        contentType: "image/png",
      });
    },
  };
}

export function fileFindNeighbor(page: Page) {
  const source = page
    .getByTestId("file-source-editor")
    .filter({ visible: true })
    .locator(".cm-content");
  return {
    async expectContent(text: string) {
      await expect(source).toContainText(text);
    },
    async openFind() {
      await source.click();
      await source.press("ControlOrMeta+f");
    },
    async closeFind() {
      await page.keyboard.press("Escape");
    },
  };
}

export function chatFindNeighbor(page: Page) {
  const assistant = page.getByTestId("assistant-message").filter({ visible: true }).last();
  const widget = page.locator('[data-chat-find-widget="true"]');
  const query = widget.getByRole("textbox");
  return {
    async expectResponse(text: string) {
      await expect(assistant).toBeVisible();
      await expect(assistant).toContainText(text);
    },
    async find(text: string, position: string) {
      await test.step(`Find ${JSON.stringify(text)} in the neighboring chat`, async () => {
        await assistant.click();
        await page.keyboard.press("ControlOrMeta+f");
        await expect(query).toBeFocused();
        await query.fill(text);
        await expect(widget.getByRole("status")).toHaveText(position);
      });
    },
    async expectQuery(text: string) {
      await expect(query).toHaveValue(text);
    },
  };
}

export function terminalFindNeighbor(page: Page, receivedFile: string) {
  const surface = page.getByTestId("terminal-surface").filter({ visible: true });
  const pane = page.getByTestId("split-group-child").filter({ has: surface });
  const shell = surface.locator(".xterm-helper-textarea");
  const query = pane.getByRole("textbox", { name: "Find in pane", exact: true });
  return {
    async find(text: string, position: string) {
      await test.step(`Find ${JSON.stringify(text)} in the neighboring terminal`, async () => {
        const otherQuery = await page.getByTestId("diff-find").getByRole("textbox").inputValue();
        await surface.click();
        await shell.press("ControlOrMeta+f");
        await expect(query).toBeFocused();
        await expect(query).not.toHaveValue(otherQuery);
        await expect(
          page
            .getByRole("textbox", { name: "Find in pane", exact: true })
            .filter({ visible: true }),
        ).toHaveCount(2);
        await query.fill(text);
        await expect(pane.getByRole("status", { name: "Find matches" })).toHaveText(position);
      });
    },
    async submitOnlyShellInput(text: string) {
      await test.step("Only ordinary input reaches the shell", async () => {
        await query.press("Escape");
        await expect(shell).toBeFocused();
        await shell.pressSequentially(text);
        await shell.press("Enter");
        await expect
          .poll(async () => {
            try {
              return await readFile(receivedFile, "utf8");
            } catch (error) {
              if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
              throw error;
            }
          })
          .toBe(`${text}\n`);
      });
    },
  };
}
