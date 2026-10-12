import { buildSettingsSectionRoute } from "@/utils/host-routes";
import { expect, test, type Page } from "../support/fixtures";
import { TerminalE2EHarness, withTerminalInApp } from "../support/helpers/terminal-dsl";

const MARKER = "COPY_ON_SELECT_MARKER";

function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

// Drags the mouse across the output line that holds `text`, like a user selecting it.
async function dragOverOutput(page: Page, text: string): Promise<void> {
  const cell = await page.evaluate((needle) => {
    const term = (
      window as Window & {
        __paseoTerminal?: {
          rows: number;
          cols: number;
          buffer: {
            active: {
              viewportY: number;
              length: number;
              getLine(y: number): { translateToString(trim: boolean): string } | undefined;
            };
          };
        };
      }
    ).__paseoTerminal;
    if (!term) return null;
    const buffer = term.buffer.active;
    // The last match is the echo output; earlier lines hold the typed command.
    for (let y = buffer.length - 1; y >= 0; y -= 1) {
      const line = buffer.getLine(y)?.translateToString(true) ?? "";
      if (line.trim() === needle) {
        return {
          row: y - buffer.viewportY,
          col: line.indexOf(needle),
          rows: term.rows,
          cols: term.cols,
        };
      }
    }
    return null;
  }, text);
  expect(cell).not.toBeNull();
  const screen = await page.locator(".xterm-screen").filter({ visible: true }).boundingBox();
  expect(screen).not.toBeNull();
  const width = screen!.width / cell!.cols;
  const height = screen!.height / cell!.rows;
  const y = screen!.y + (cell!.row + 0.5) * height;
  await page.mouse.move(screen!.x + (cell!.col + 0.2) * width, y);
  await page.mouse.down();
  await page.mouse.move(screen!.x + (cell!.col + text.length - 0.2) * width, y, { steps: 8 });
  await page.mouse.up();
}

test("copy on select copies a mouse selection in the terminal", async ({ page, context }) => {
  // Read only: browsers deny clipboard-write by default, and the copy must work without it.
  await context.grantPermissions(["clipboard-read"]);
  const harness = await TerminalE2EHarness.create({ tempPrefix: "copy-on-select-" });
  try {
    await page.goto(buildSettingsSectionRoute("terminal"));
    const toggle = page.getByRole("switch", { name: "Copy on select" });
    await toggle.click();
    await expect(toggle).toBeChecked();

    await withTerminalInApp(page, harness, { name: "copy-on-select" }, async () => {
      await harness.setupPrompt(page, MARKER);
      expect(await readClipboard(page)).not.toBe(MARKER);

      await dragOverOutput(page, MARKER);

      await expect.poll(() => readClipboard(page)).toBe(MARKER);
    });
  } finally {
    await harness.cleanup();
  }
});
