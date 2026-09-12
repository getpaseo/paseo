import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { openFileExplorer, openFileFromExplorer } from "../support/helpers/file-explorer";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";

function source(page: Page) {
  return page.getByTestId("file-source-editor").filter({ visible: true }).locator(".cm-content");
}
function query(page: Page) {
  return page.getByRole("textbox", { name: "Find in pane", exact: true });
}
function status(page: Page) {
  return page.getByRole("status", { name: "Find matches" });
}
async function openSource(page: Page, filename: string) {
  await openFileExplorer(page);
  await openFileFromExplorer(page, filename);
  await expect(source(page)).toBeVisible();
}
async function findInSource(page: Page, text: string) {
  await source(page).focus();
  await source(page).press("ControlOrMeta+f");
  await expect(query(page)).toBeFocused();
  await query(page).fill(text);
}
async function expectQuerySelected(page: Page, text: string) {
  await expect(query(page)).toBeFocused();
  await expect(query(page)).toHaveValue(text);
  await expect
    .poll(() =>
      query(page).evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd]),
    )
    .toEqual([0, text.length]);
}
async function closeFind(page: Page) {
  await query(page).press("Escape");
  await expect(source(page)).toBeFocused();
}
async function expectActiveMatchUncovered(page: Page) {
  const match = page.locator(".cm-searchMatch-selected").filter({ visible: true }).first();
  await expect(match).toBeVisible();
  const widget = page.getByLabel("Find", { exact: true }).filter({ visible: true });
  await expect
    .poll(async () => {
      const m = await match.boundingBox();
      const w = await widget.boundingBox();
      if (!m || !w) return "missing";
      const covered =
        m.x < w.x + w.width && m.x + m.width > w.x && m.y < w.y + w.height && m.y + m.height > w.y;
      return covered ? "covered by Find" : "visible";
    })
    .toBe("visible");
}

async function findBoxes(page: Page) {
  const pane = (await page
    .getByTestId("workspace-file-pane")
    .filter({ visible: true })
    .boundingBox())!;
  const widget = (await page
    .getByLabel("Find", { exact: true })
    .filter({ visible: true })
    .boundingBox())!;
  return { pane, widget };
}

async function expectFindInsidePane(page: Page) {
  const { pane, widget } = await findBoxes(page);
  expect(widget.x).toBeGreaterThanOrEqual(pane.x);
  expect(widget.x + widget.width).toBeLessThanOrEqual(pane.x + pane.width);
  expect(widget.y).toBeGreaterThanOrEqual(pane.y);
  expect(widget.y + widget.height).toBeLessThanOrEqual(pane.y + pane.height + 1);
}

async function expectFindAtTopRight(page: Page) {
  await expectFindInsidePane(page);
  const { pane, widget } = await findBoxes(page);
  expect(widget.y).toBeLessThan(pane.y + 70);
}

test("finds literal text at the top of editable source and returns focus at the inspected match", async ({
  page,
  withWorkspace,
}, testInfo) => {
  const workspace = await withWorkspace({ prefix: "pane-find-" });
  const file = path.join(workspace.repoPath, "source.txt");
  await writeFile(file, "first a.b\nsecond axb\nthird a.b\n");
  await workspace.navigateTo();
  await openSource(page, "source.txt");
  await findInSource(page, "a.b");
  await expect(status(page)).toHaveText("1 of 2");
  await query(page).fill("A.B");
  await expect(status(page)).toHaveText("1 of 2");
  await query(page).fill("a.b");
  await expectFindAtTopRight(page);
  await query(page).press("Enter");
  await expect(status(page)).toHaveText("2 of 2");
  await query(page).press("Shift+Enter");
  await expect(status(page)).toHaveText("1 of 2");
  await page.screenshot({ path: testInfo.outputPath("editable-find.png") });
  await closeFind(page);
  await expect(query(page)).toBeHidden();
  await expect(page.getByLabel("Line 1, column 10")).toBeVisible();
  await expect(page.getByRole("button", { name: "Find", exact: true })).toHaveCount(0);

  await test.step("reopen with the shortcut, preserve replace and Undo/save", async () => {
    await source(page).press("ControlOrMeta+f");
    await expect(query(page)).toBeFocused();
    await page.getByRole("button", { name: "Toggle replace" }).click();
    await page.getByRole("textbox", { name: "Replace with" }).fill("literal");
    await page.getByRole("button", { name: "Replace", exact: true }).click();
    await expect(source(page)).toContainText("first literal");
    await expect(status(page)).toHaveText("1 of 1");
    await page.screenshot({ path: testInfo.outputPath("replace.png") });
    await closeFind(page);
    await source(page).press("ControlOrMeta+z");
    await expect(source(page)).toContainText("first a.b");
    await source(page).press("ControlOrMeta+s");
    await expect.poll(() => readFile(file, "utf8")).toBe("first a.b\nsecond axb\nthird a.b\n");
    await findInSource(page, "a.b");
    await page.getByRole("button", { name: "Toggle replace" }).click();
    await page.getByRole("textbox", { name: "Replace with" }).fill("all");
    await page.getByRole("button", { name: "Replace all", exact: true }).click();
    await expect(status(page)).toHaveText("No matches");
    await closeFind(page);
    await source(page).press("ControlOrMeta+s");
    await expect.poll(() => readFile(file, "utf8")).toBe("first all\nsecond axb\nthird all\n");
  });
});

test("searches the unsaved buffer while disconnected", async ({ page, withWorkspace }) => {
  const gate = await installDaemonWebSocketGate(page);
  const workspace = await withWorkspace({ prefix: "pane-find-draft-" });
  const file = path.join(workspace.repoPath, "draft.txt");
  await writeFile(file, "saved on disk\n");
  await workspace.navigateTo();
  await openSource(page, "draft.txt");
  await gate.drop();
  await source(page).fill("unsaved needle\nsecond needle\n");
  await findInSource(page, "needle");
  await expect(status(page)).toHaveText("1 of 2");
  expect(await readFile(file, "utf8")).toBe("saved on disk\n");
  gate.restore();
});

test("searches read-only source beyond the viewport without replace controls", async ({
  page,
  withWorkspace,
}, testInfo) => {
  const workspace = await withWorkspace({ prefix: "pane-find-readonly-" });
  await writeFile(
    path.join(workspace.repoPath, "large.txt"),
    "needle first\n" + "plain source line\n".repeat(70_000) + "needle last\n",
  );
  await workspace.navigateTo();
  await openSource(page, "large.txt");
  await findInSource(page, "needle");
  await expect(source(page)).toHaveAttribute("contenteditable", "false");
  await expect(status(page)).toHaveText("1 of 2");
  await expect(page.getByRole("button", { name: "Toggle replace" })).toHaveCount(0);
  await query(page).press("Enter");
  await expect(status(page)).toHaveText("2 of 2");
  await expect(source(page)).toContainText("needle last");
  await page.screenshot({ path: testInfo.outputPath("readonly-find.png") });
  await closeFind(page);
  await source(page).press("ControlOrMeta+f");
  await expect(query(page)).toBeFocused();
  await query(page).fill("plain");
  await expect(status(page)).toHaveText("1 of 10000+");
});

test("targets the focused source in split panes and refocuses an open query", async ({
  page,
  withWorkspace,
}, testInfo) => {
  const workspace = await withWorkspace({ prefix: "pane-find-split-" });
  await writeFile(path.join(workspace.repoPath, "left.txt"), "left needle\n");
  await writeFile(path.join(workspace.repoPath, "right.txt"), "right needle\nright needle\n");
  await workspace.navigateTo();
  await openSource(page, "left.txt");
  await runWorkspaceActionFromCommandCenter(page, "Split pane right");
  await openFileFromExplorer(page, "right.txt");
  const left = source(page).filter({ hasText: "left needle" });
  const right = source(page).filter({ hasText: "right needle" });
  await expect(left).toBeVisible();
  await expect(right).toBeVisible();
  await left.click();
  await left.press("ControlOrMeta+f");
  await query(page).fill("needle");
  await expect(status(page)).toHaveText("1 of 1");
  await query(page).press("Escape");
  await right.click();
  await right.press("ControlOrMeta+f");
  await query(page).fill("needle");
  await expect(status(page)).toHaveText("1 of 2");
  await right.click();
  await right.press("ControlOrMeta+f");
  await expect(query(page)).toBeFocused();
  await expect(query(page)).toHaveValue("needle");
  await page.screenshot({ path: testInfo.outputPath("split-find.png") });
});

test.describe("narrow touch browser", () => {
  test.use({ hasTouch: true });
  test("keeps Find controls inside a narrow source pane", async ({
    page,
    withWorkspace,
  }, testInfo) => {
    const workspace = await withWorkspace({ prefix: "pane-find-touch-" });
    await writeFile(path.join(workspace.repoPath, "touch.txt"), "touch needle\nnext needle\n");
    await workspace.navigateTo();
    await openSource(page, "touch.txt");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("button", { name: "Find", exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("touch-find-closed.png") });
    await source(page).focus();
    await source(page).press("ControlOrMeta+f");
    await expect(query(page)).toBeFocused();
    await query(page).fill("needle");
    await page.getByRole("button", { name: "Next match" }).tap();
    await expect(status(page)).toHaveText("2 of 2");
    await expectFindInsidePane(page);
    await page.screenshot({ path: testInfo.outputPath("touch-find.png") });
    await page.getByRole("button", { name: "Close Find" }).tap();
    await expect(source(page)).toBeFocused();
  });
});

async function selectFirstTwoLines(page: Page) {
  await source(page).focus();
  await source(page).press("ControlOrMeta+Home");
  await source(page).press("Shift+ArrowDown");
  await source(page).press("Shift+End");
}

async function selectLastWord(page: Page) {
  await source(page).focus();
  await source(page).press("ControlOrMeta+End");
  await source(page).press("ArrowUp");
  await source(page).press("Home");
  await source(page).press("Shift+End");
}

test("declines multiline selection seeds and keeps replacement aligned with the visible query", async ({
  page,
  withWorkspace,
}, testInfo) => {
  const workspace = await withWorkspace({ prefix: "pane-find-single-line-" });
  const file = path.join(workspace.repoPath, "selection.txt");
  await writeFile(file, "alpha\nbeta\nalphabeta\n");
  await workspace.navigateTo();
  await openSource(page, "selection.txt");

  await selectFirstTwoLines(page);
  await source(page).press("ControlOrMeta+f");
  await expect(query(page)).toBeFocused();
  await expect(query(page)).toHaveValue("");
  await expect(page.getByRole("button", { name: "Next match" })).toBeDisabled();
  await query(page).press("Enter");
  await expect(query(page)).toHaveValue("");
  await closeFind(page);

  await selectFirstTwoLines(page);
  await source(page).press("ControlOrMeta+g");
  await expect(query(page)).toHaveValue("");
  await expect(page.getByRole("button", { name: "Next match" })).toBeDisabled();
  await closeFind(page);

  await selectLastWord(page);
  await source(page).press("ControlOrMeta+f");
  await expect(query(page)).toHaveValue("alphabeta");
  await query(page).press("Enter");
  await expect(status(page)).toHaveText("1 of 1");
  await closeFind(page);
  await expect(page.getByLabel("Line 3, column 10")).toBeVisible();

  await selectFirstTwoLines(page);
  await source(page).press("ControlOrMeta+f");
  await expect(query(page)).toHaveValue("alphabeta");
  await query(page).press("Enter");
  await expect(status(page)).toHaveText("1 of 1");
  await page.getByRole("button", { name: "Toggle replace" }).click();
  await page.getByRole("textbox", { name: "Replace with" }).fill("replaced");
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(source(page)).toContainText("alpha");
  await expect(source(page)).toContainText("beta");
  await expect(status(page)).toHaveText("No matches");
  await page.screenshot({ path: testInfo.outputPath("single-line-query-replacement.png") });
  await closeFind(page);
  await source(page).press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe("alpha\nbeta\nreplaced\n");
});

for (const startingField of ["Find in pane", "Replace with"] as const) {
  test(`repeated Find from ${startingField} selects the query for new typing`, async ({
    page,
    withWorkspace,
  }, testInfo) => {
    const workspace = await withWorkspace({ prefix: "pane-find-repeat-input-" });
    await writeFile(path.join(workspace.repoPath, "source.txt"), "needle first\nneedle second\n");
    await workspace.navigateTo();
    await openSource(page, "source.txt");
    await findInSource(page, "needle");
    await page.getByRole("button", { name: "Toggle replace" }).click();
    const replacement = page.getByRole("textbox", { name: "Replace with" });
    await replacement.fill("replacement");

    await test.step("repeat Find from the input and type a fresh query", async () => {
      const startingInput = page.getByRole("textbox", { name: startingField, exact: true });
      await startingInput.press("End");
      await startingInput.press("ControlOrMeta+f");
      await expectQuerySelected(page, "needle");
      await page.keyboard.type("first");
      await expect(query(page)).toHaveValue("first");
      await expect(replacement).toHaveValue("replacement");
      await expect(status(page)).toHaveText("1 of 1");
    });

    await page.screenshot({ path: testInfo.outputPath("repeat-find-input.png") });
    await closeFind(page);
    await expect(page.getByLabel("Line 1, column 13")).toBeVisible();
  });
}

test.describe("the active match stays visible under the floating widget", () => {
  test.describe("narrow touch browser", () => {
    test.use({ hasTouch: true });
    test("reveals a short file's match that the widget would cover", async ({
      page,
      withWorkspace,
    }, testInfo) => {
      const workspace = await withWorkspace({ prefix: "pane-find-cover-touch-" });
      await writeFile(path.join(workspace.repoPath, "touch.txt"), "touch needle\nnext needle\n");
      await workspace.navigateTo();
      await openSource(page, "touch.txt");
      await page.setViewportSize({ width: 390, height: 844 });
      await source(page).focus();
      await source(page).press("ControlOrMeta+f");
      await expect(query(page)).toBeFocused();
      await query(page).fill("needle");
      await expect(status(page)).toHaveText("1 of 2");
      await expectActiveMatchUncovered(page);
      await page.getByRole("button", { name: "Next match" }).tap();
      await expect(status(page)).toHaveText("2 of 2");
      await expectActiveMatchUncovered(page);
      await page.screenshot({ path: testInfo.outputPath("touch-match-uncovered.png") });
      await expect(query(page)).toHaveValue("needle");
      await page.getByRole("button", { name: "Close Find" }).tap();
      await expect(source(page)).toBeFocused();
    });
  });

  test("reveals a match beneath the top-right widget in a narrow desktop pane", async ({
    page,
    withWorkspace,
  }, testInfo) => {
    const workspace = await withWorkspace({ prefix: "pane-find-cover-split-" });
    await writeFile(path.join(workspace.repoPath, "left.txt"), "left filler\n");
    await writeFile(path.join(workspace.repoPath, "right.txt"), "needle one\nplain\n");
    await workspace.navigateTo();
    await openSource(page, "left.txt");
    await runWorkspaceActionFromCommandCenter(page, "Split pane right");
    await openFileFromExplorer(page, "right.txt");
    const right = source(page).filter({ hasText: "needle one" });
    await expect(right).toBeVisible();
    await right.click();
    await right.press("ControlOrMeta+f");
    await query(page).fill("needle");
    await expect(status(page)).toHaveText("1 of 1");
    await expectActiveMatchUncovered(page);
    await page.screenshot({ path: testInfo.outputPath("split-match-uncovered.png") });

    await test.step("stays visible when Replace expands the widget", async () => {
      await page.getByRole("button", { name: "Toggle replace" }).click();
      await page.getByRole("textbox", { name: "Replace with" }).fill("hay");
      await expectActiveMatchUncovered(page);
      await page.screenshot({ path: testInfo.outputPath("split-replace-uncovered.png") });
    });

    await test.step("navigation and query focus still work", async () => {
      await query(page).press("ControlOrMeta+f");
      await expectQuerySelected(page, "needle");
      await query(page).press("Enter");
      await expect(status(page)).toHaveText("1 of 1");
      await expectActiveMatchUncovered(page);
    });
    await query(page).press("Escape");
    await expect(right).toBeFocused();
  });
});

test("Go to line keeps its dialog with Find closed and open", async ({
  page,
  withWorkspace,
}, testInfo) => {
  const workspace = await withWorkspace({ prefix: "pane-find-goto-" });
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
  await writeFile(path.join(workspace.repoPath, "lines.txt"), `${lines}\n`);
  await workspace.navigateTo();
  await openSource(page, "lines.txt");
  const gotoInput = page.getByRole("textbox", { name: "Go to line" });

  await test.step("with Find closed", async () => {
    await source(page).focus();
    await source(page).press("ControlOrMeta+Alt+g");
    await expect(gotoInput).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("goto-line-find-closed.png") });
    await gotoInput.fill("12");
    await gotoInput.press("Enter");
    await expect(page.getByLabel("Line 12, column 1")).toBeVisible();
    await expect(gotoInput).toBeHidden();
  });

  await test.step("with Find open", async () => {
    await source(page).press("ControlOrMeta+f");
    await expect(query(page)).toBeFocused();
    await query(page).fill("line 3");
    await source(page).focus();
    await source(page).press("ControlOrMeta+Alt+g");
    await expect(gotoInput).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("goto-line-find-open.png") });
    await gotoInput.fill("30");
    await gotoInput.press("Enter");
    await expect(page.getByLabel("Line 30, column 1")).toBeVisible();
    await expect(query(page)).toHaveValue("line 3");
    await expect(status(page)).toHaveText("11 matches");
  });
});
