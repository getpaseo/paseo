import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
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
});
