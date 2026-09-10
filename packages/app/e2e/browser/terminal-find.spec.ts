import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { TerminalE2EHarness } from "../support/helpers/terminal-dsl";
import { getTerminalBufferText, buildTerminalWorkspaceUrl } from "../support/helpers/terminal-perf";

function query(page: Page) {
  return page.getByRole("textbox", { name: "Find in pane", exact: true }).filter({ visible: true });
}
function status(page: Page) {
  return page.getByRole("status", { name: "Find matches" }).filter({ visible: true });
}
function input(page: Page) {
  return page
    .getByTestId("terminal-surface")
    .filter({ visible: true })
    .locator(".xterm-helper-textarea");
}
async function openFind(page: Page, text?: string) {
  await input(page).press("ControlOrMeta+f");
  await expect(query(page)).toBeFocused();
  if (text !== undefined) await query(page).fill(text);
}
async function expectSelectedQuery(page: Page, text: string) {
  await expect(query(page)).toBeFocused();
  await expect(query(page)).toHaveValue(text);
  await expect
    .poll(() =>
      query(page).evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]),
    )
    .toEqual([0, text.length]);
}
async function expectUncoveredMatch(page: Page) {
  const widget = page.getByLabel("Find", { exact: true });
  await expect
    .poll(async () => {
      const selected = await page.evaluate(() => {
        const term = (
          window as Window & {
            __paseoTerminal?: {
              rows: number;
              cols: number;
              buffer: { active: { viewportY: number } };
              getSelectionPosition():
                | { start: { x: number; y: number }; end: { x: number; y: number } }
                | undefined;
            };
          }
        ).__paseoTerminal;
        const selection = term?.getSelectionPosition();
        return term && selection
          ? { selection, rows: term.rows, cols: term.cols, firstRow: term.buffer.active.viewportY }
          : null;
      });
      const screen = await page.locator(".xterm-screen").filter({ visible: true }).boundingBox();
      const w = await widget.boundingBox();
      if (!selected || !screen || !w) return false;
      const x = screen.x + (selected.selection.start.x * screen.width) / selected.cols;
      const y =
        screen.y +
        ((selected.selection.start.y - selected.firstRow) * screen.height) / selected.rows;
      const height = screen.height / selected.rows;
      return (
        y >= screen.y &&
        y + height <= screen.y + screen.height + 1 &&
        !(x >= w.x && x < w.x + w.width && y < w.y + w.height && y + height > w.y)
      );
    })
    .toBe(true);
}
async function viewport(page: Page) {
  return page.evaluate(
    () =>
      (window as Window & { __paseoTerminal?: { buffer: { active: { viewportY: number } } } })
        .__paseoTerminal?.buffer.active.viewportY,
  );
}

let harness: TerminalE2EHarness;
test.beforeEach(async () => {
  harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-find-" });
});
test.afterEach(async () => {
  await harness.cleanup();
});

test("searches retained output without sending Find input to the shell", async ({
  page,
}, testInfo) => {
  const received = path.join(harness.tempRepo.path, "received.txt");
  const trigger = path.join(harness.tempRepo.path, "output.trigger");
  const bottomTrigger = path.join(harness.tempRepo.path, "bottom.trigger");
  const script = `stty -echo; printf 'first a.b\\n'; for i in $(seq 1 90); do printf 'line %s\\n' "$i"; done; printf 'last A.B\\nREADY\\n'; (while [ ! -f output.trigger ]; do sleep 0.05; done; printf 'new output\\n'; while [ ! -f bottom.trigger ]; do sleep 0.05; done; for i in $(seq 1 30); do printf 'bottom output %s\\n' "$i"; done) & while IFS= read -r line; do printf '%s\\n' "$line" >> received.txt; done`;
  await writeFile(received, "");
  const terminal = await harness.createTerminal({
    name: "Find fixture",
    command: "bash",
    args: ["--noprofile", "--norc", "-c", script],
  });
  await harness.openTerminal(page, { terminalId: terminal.id });
  await expect.poll(() => getTerminalBufferText(page)).toContain("READY");
  await openFind(page, "a.b");
  await expect(status(page)).toHaveText("2 of 2");
  await query(page).press("Shift+Enter");
  await expect(status(page)).toHaveText("1 of 2");
  await expectUncoveredMatch(page);
  const findBox = await page.getByLabel("Find", { exact: true }).boundingBox();
  const surfaceBox = await page.getByTestId("terminal-surface").boundingBox();
  expect(findBox!.y).toBeLessThan(surfaceBox!.y + 70);
  const inspected = await viewport(page);
  await writeFile(trigger, "go");
  await expect.poll(() => getTerminalBufferText(page)).toContain("new output");
  await expect.poll(() => viewport(page)).toBe(inspected);
  await page.screenshot({ path: testInfo.outputPath("scrollback-find.png") });
  await query(page).press("Enter");
  await expect(status(page)).toHaveText("2 of 2");
  const inspectedBottom = await viewport(page);
  await writeFile(bottomTrigger, "go");
  await expect.poll(() => getTerminalBufferText(page)).toContain("bottom output 30");
  await expect.poll(() => viewport(page)).toBe(inspectedBottom);
  await expectUncoveredMatch(page);
  await query(page).press("Enter");
  await expect(status(page)).toHaveText("1 of 2");
  await query(page).press("ControlOrMeta+f");
  await expectSelectedQuery(page, "a.b");
  await query(page).fill("A.B");
  await expect(status(page)).toHaveText("1 of 2");
  await query(page).fill("absent[.*]");
  await expect(status(page)).toHaveText("No matches");
  await query(page).fill("a.b");
  await query(page).press("Escape");
  await expect(query(page)).toBeHidden();
  await expect(input(page)).toBeFocused();
  await expect(page.locator(".xterm-find-result-decoration")).toHaveCount(0);
  await input(page).pressSequentially("only-shell-input");
  await input(page).press("Enter");
  await expect.poll(() => readFile(received, "utf8")).toBe("only-shell-input\n");
  await input(page).pressSequentially("discard");
  await input(page).press("Control+u");
  await input(page).pressSequentially("ordinary-input");
  await input(page).press("Enter");
  await expect.poll(() => readFile(received, "utf8")).toBe("only-shell-input\nordinary-input\n");
  await openFind(page);
  await expectSelectedQuery(page, "a.b");
  await expect(status(page)).toHaveText(/of 2/);
  await expectUncoveredMatch(page);
  await expect(page.getByRole("button", { name: "Toggle replace" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Find", exact: true })).toHaveCount(0);
});

test("keeps terminal Find owned by retained tabs and the focused split pane", async ({
  page,
}, testInfo) => {
  const first = await harness.createTerminal({
    name: "First search",
    command: "bash",
    args: ["-c", "printf 'first needle\\n'; cat"],
  });
  const second = await harness.createTerminal({
    name: "Second search",
    command: "bash",
    args: ["-c", "printf 'second needle\\nsecond needle\\n'; cat"],
  });
  await harness.openTerminal(page, { terminalId: first.id });
  await openFind(page, "needle");
  await expect(status(page)).toHaveText("1 of 1");
  await page.getByTestId(`workspace-tab-terminal_${second.id}`).first().click();
  await openFind(page, "needle");
  await expect(status(page).filter({ visible: true })).toHaveText("2 of 2");
  await query(page).filter({ visible: true }).press("Escape");
  await page.getByTestId(`workspace-tab-terminal_${first.id}`).first().click();
  await input(page).press("ControlOrMeta+f");
  await expectSelectedQuery(page, "needle");
  await expect(status(page).filter({ visible: true })).toHaveText("1 of 1");
  await query(page).filter({ visible: true }).press("Escape");
  await runWorkspaceActionFromCommandCenter(page, "Split pane right");
  await page.getByTestId(`workspace-tab-terminal_${second.id}`).first().click();
  await runWorkspaceActionFromCommandCenter(page, "Move tab right");
  const left = page
    .getByTestId("split-group-child")
    .filter({ has: page.getByTestId(`workspace-tab-terminal_${first.id}`) });
  const right = page
    .getByTestId("split-group-child")
    .filter({ has: page.getByTestId(`workspace-tab-terminal_${second.id}`) });
  await expect(left.locator(".xterm-helper-textarea")).toHaveCount(1);
  await expect(right.locator(".xterm-helper-textarea")).toHaveCount(1);
  await right.getByTestId("terminal-surface").click();
  await right.locator(".xterm-helper-textarea").press("ControlOrMeta+f");
  await expect(right.getByRole("textbox", { name: "Find in pane", exact: true })).toBeFocused();
  await right.getByRole("textbox", { name: "Find in pane", exact: true }).fill("needle");
  await expect(right.getByRole("status", { name: "Find matches" })).toHaveText(/of 2/);
  await expect(left.getByRole("textbox", { name: "Find in pane", exact: true })).toHaveCount(0);
  await right.getByRole("textbox", { name: "Find in pane", exact: true }).press("Escape");
  await left.getByTestId("terminal-surface").click();
  await left.locator(".xterm-helper-textarea").press("ControlOrMeta+f");
  await expect(left.getByRole("textbox", { name: "Find in pane", exact: true })).toBeFocused();
  await left.getByRole("textbox", { name: "Find in pane", exact: true }).fill("needle");
  await expect(left.getByRole("status", { name: "Find matches" })).toHaveText("1 of 1");
  await page.screenshot({ path: testInfo.outputPath("split-find.png") });
});

test("keeps the shared Find controls usable in a compact dark browser", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.emulateMedia({ colorScheme: "dark" });
  const terminal = await harness.createTerminal({
    name: "Compact search",
    command: "bash",
    args: ["-c", "printf 'needle\\nneedle\\n'; cat"],
  });
  await page.goto(buildTerminalWorkspaceUrl(harness.workspaceId, terminal.id));
  await expect(page.getByTestId("terminal-surface")).toBeVisible();
  await page.getByTestId("terminal-surface").click();
  await openFind(page, "needle");
  await expect(status(page)).toHaveText("2 of 2");
  await page.getByRole("button", { name: "Previous match" }).click();
  await expect(status(page)).toHaveText("1 of 2");
  await page.getByRole("button", { name: "Next match" }).click();
  await expect(status(page)).toHaveText("2 of 2");
  const box = await page.getByLabel("Find", { exact: true }).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("compact-find.png") });
  await page.getByRole("button", { name: "Close Find" }).click();
  await expect(input(page)).toBeFocused();
});
