import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { TerminalE2EHarness } from "../support/helpers/terminal-dsl";
import { openCommandCenter, closeCommandCenter } from "../support/helpers/command-center";

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

  test("workspace number shortcuts refocus a retained terminal", async ({ page }) => {
    const first = await harness.createTerminal({ name: "focus-first" });
    const other = await harness.createOtherWorkspace();
    const second = await other.createTerminal({ name: "focus-second" });
    await harness.openTerminal(page, { terminalId: first.id });
    await other.openTerminal(page, { terminalId: second.id });
    await other.expectTerminalFocused(page);
    await harness.switchToWorkspaceByShortcut(page);
    await harness.expectTerminalFocused(page);
    await other.switchToWorkspaceByShortcut(page);
    await other.expectTerminalFocused(page);
    await other.typeCommandAndExpectOutput(page, {
      terminalId: second.id,
      command: "printf 'WORKSPACE_FOCUS_OK\\n'",
      output: "WORKSPACE_FOCUS_OK",
    });
  });

  test("closing an overlay after returning to a workspace refocuses its terminal", async ({
    page,
  }) => {
    const first = await harness.createTerminal({ name: "overlay-first" });
    const other = await harness.createOtherWorkspace();
    const second = await other.createTerminal({ name: "overlay-second" });
    await harness.openTerminal(page, { terminalId: first.id });
    await other.openTerminal(page, { terminalId: second.id });
    await harness.switchToWorkspaceByShortcut(page);
    await harness.expectTerminalFocused(page);
    await harness.rememberWorkspaceForHistoryReturn(page);
    await other.switchToWorkspaceByShortcut(page);
    const overlay = await openCommandCenter(page);
    await harness.returnToWorkspaceThroughHistory(page);
    await expect(overlay.getByTestId("command-center-input")).toBeFocused();
    await closeCommandCenter(page);
    await harness.expectTerminalFocused(page);
    await harness.typeCommandAndExpectOutput(page, {
      terminalId: first.id,
      command: "printf 'OVERLAY_FOCUS_OK\\n'",
      output: "OVERLAY_FOCUS_OK",
    });
  });

  test("moving focus inside an overlay preserves deferred terminal focus", async ({ page }) => {
    const first = await harness.createTerminal({ name: "overlay-move-first" });
    const other = await harness.createOtherWorkspace();
    const second = await other.createTerminal({ name: "overlay-move-second" });
    await harness.openTerminal(page, { terminalId: first.id });
    await other.openTerminal(page, { terminalId: second.id });
    await harness.switchToWorkspaceByShortcut(page);
    await harness.expectTerminalFocused(page);
    await harness.rememberWorkspaceForHistoryReturn(page);
    await other.switchToWorkspaceByShortcut(page);
    await openCommandCenter(page);
    await harness.returnToWorkspaceThroughHistory(page);
    await harness.moveFocusWithinCommandCenter(page);
    await closeCommandCenter(page);
    await harness.expectTerminalFocused(page);
    await harness.typeCommandAndExpectOutput(page, {
      terminalId: first.id,
      command: "printf 'OVERLAY_MOVE_FOCUS_OK\\n'",
      output: "OVERLAY_MOVE_FOCUS_OK",
    });
  });

  test("deferred terminal focus does not steal focus from a button", async ({ page }) => {
    const first = await harness.createTerminal({ name: "button-first" });
    const other = await harness.createOtherWorkspace();
    const second = await other.createTerminal({ name: "button-second" });
    await harness.openTerminal(page, { terminalId: first.id });
    await other.openTerminal(page, { terminalId: second.id });
    await harness.switchToWorkspaceByShortcut(page);
    await harness.expectTerminalFocused(page);
    await harness.rememberWorkspaceForHistoryReturn(page);
    await other.switchToWorkspaceByShortcut(page);
    const overlay = await openCommandCenter(page);
    await harness.returnToWorkspaceThroughHistory(page);
    await expect(overlay.getByTestId("command-center-input")).toBeFocused();
    await harness.closeOverlayAndFocusButtonBeforeRetry(page);
    await expect(page.getByTestId("sidebar-search")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(overlay).toBeVisible();
  });
});
