import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import {
  expectTerminalCursor,
  getTerminalBufferText,
  waitForTerminalContent,
} from "../support/helpers/terminal-perf";
import { TerminalE2EHarness } from "../support/helpers/terminal-dsl";

interface AttachOverlayProbeWindow extends Window {
  __terminalAttachOverlaySeen?: boolean;
  __terminalAttachOverlayObserver?: MutationObserver;
}

async function watchForTerminalAttachOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as AttachOverlayProbeWindow;
    win.__terminalAttachOverlaySeen = false;
    win.__terminalAttachOverlayObserver?.disconnect();
    win.__terminalAttachOverlayObserver = new MutationObserver(() => {
      if (document.querySelector('[data-testid="terminal-attach-loading"]')) {
        win.__terminalAttachOverlaySeen = true;
      }
    });
    win.__terminalAttachOverlayObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  });
}

async function terminalAttachOverlayWasSeen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const win = window as AttachOverlayProbeWindow;
    win.__terminalAttachOverlayObserver?.disconnect();
    return win.__terminalAttachOverlaySeen === true;
  });
}

test.describe("retained terminal tab streams", () => {
  let harness: TerminalE2EHarness;

  test.beforeEach(async () => {
    harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-retained-tab-stream-" });
  });

  test.afterEach(async () => {
    await harness.cleanup();
  });

  test("switching back to a retained terminal does not reattach its stream", async ({ page }) => {
    const first = await harness.createTerminal({ name: "retained-first" });
    const second = await harness.createTerminal({ name: "retained-second" });

    await harness.openTerminal(page, { terminalId: first.id });
    const secondTab = page.getByTestId(`workspace-tab-terminal_${second.id}`).first();
    await secondTab.click();
    await expect(page.getByTestId("terminal-attach-loading")).toBeHidden({ timeout: 10_000 });

    await watchForTerminalAttachOverlay(page);
    await page.getByTestId(`workspace-tab-terminal_${first.id}`).first().click();
    await expect(page.getByTestId("terminal-surface").filter({ visible: true })).toHaveCount(1);
    await page.waitForTimeout(100);

    expect(await terminalAttachOverlayWasSeen(page)).toBe(false);
  });

  for (const { count, retainedMarker } of [
    { count: 3000, retainedMarker: "history-0001界🙂" },
    { count: 12050, retainedMarker: "history-3000界🙂" },
  ]) {
    test(`reattach restores retained styled Unicode history from ${count} lines`, async ({
      page,
    }) => {
      await page.addInitScript(() => {
        const key = "@paseo:app-settings";
        const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
        localStorage.setItem(key, JSON.stringify({ ...settings, terminalScrollbackLines: 10000 }));
      });
      const terminal = await harness.createTerminal({
        name: `history-${count}`,
        command: "/bin/sh",
        args: [
          "-lc",
          `i=1; while [ $i -le ${count} ]; do printf '\\033[31mhistory-%04d界🙂 payload-abcdefghijklmnopqrstuvwxyz0123456789\\033[0m\\n' $i; i=$((i+1)); done; sleep 120`,
        ],
      });
      const last = `history-${String(count).padStart(4, "0")}界🙂`;
      await harness.openTerminal(page, { terminalId: terminal.id });
      await waitForTerminalContent(page, (text) => text.includes(last), 10000);
      expect(await getTerminalBufferText(page)).toContain(retainedMarker);
      await page.reload();
      await waitForTerminalContent(page, (text) => text.includes(last), 10000);
      const restored = await getTerminalBufferText(page);
      expect(restored).toContain(retainedMarker);
      expect(restored.match(/history-\d{4,5}/g)?.length).toBeGreaterThanOrEqual(
        Math.min(count, 10000),
      );
      if (count > 10000) expect(restored).not.toContain("history-0001界🙂");
    });
  }
  for (const input of [
    { name: "client blinking bar", presentation: "", shape: "bar" as const, blinking: true },
    {
      name: "program blinking underline",
      presentation: "\x1b[3 q",
      shape: "underline" as const,
      blinking: true,
    },
  ]) {
    test(`reattach preserves the ${input.name} cursor`, async ({ page }) => {
      const terminal = await harness.createTerminal({
        name: "cursor-presentation",
        command: process.execPath,
        args: [
          "-e",
          `process.stdout.write(${JSON.stringify(input.presentation + "CURSOR-READY\r\n")});setInterval(()=>{},1000)`,
        ],
      });
      await harness.openTerminal(page, { terminalId: terminal.id });
      await waitForTerminalContent(page, (text) => text.includes("CURSOR-READY"), 10000);
      await expectTerminalCursor(page, input);
      await page.reload();
      await waitForTerminalContent(page, (text) => text.includes("CURSOR-READY"), 10000);
      await expectTerminalCursor(page, input);
    });
  }
});
