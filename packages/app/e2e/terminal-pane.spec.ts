import { test, expect, type Page } from "./fixtures";
import {
  createAgent,
  ensureHostSelected,
  gotoHome,
  setWorkingDirectory,
} from "./helpers/app";
import { createTempGitRepo } from "./helpers/workspace";

function visibleTestId(page: Page, testId: string) {
  return page.locator(`[data-testid="${testId}"]:visible`).first();
}

function visibleTestIdPrefix(page: Page, prefix: string) {
  return page.locator(`[data-testid^="${prefix}"]:visible`);
}

let terminalMarkerCounter = 0;

function shortTerminalMarker(prefix: string): string {
  terminalMarkerCounter += 1;
  return `${prefix.slice(0, 1)}${terminalMarkerCounter.toString(36)}`;
}

function parseAgentFromUrl(url: string): { serverId: string; agentId: string } {
  const pathname = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();

  const modernMatch = pathname.match(/\/h\/([^/]+)\/agent\/([^/?#]+)/);
  if (modernMatch) {
    return {
      serverId: decodeURIComponent(modernMatch[1]),
      agentId: decodeURIComponent(modernMatch[2]),
    };
  }

  const legacyMatch = pathname.match(/\/agent\/([^/]+)\/([^/?#]+)/);
  if (legacyMatch) {
    return {
      serverId: decodeURIComponent(legacyMatch[1]),
      agentId: decodeURIComponent(legacyMatch[2]),
    };
  }

  throw new Error(`Expected /h/:serverId/agent/:agentId URL, got ${url}`);
}

async function openAgentFromSidebar(page: Page, serverId: string, agentId: string): Promise<void> {
  await gotoHome(page);
  const row = page.getByTestId(`agent-row-${serverId}-${agentId}`).first();
  await expect(row).toBeVisible({ timeout: 30000 });
  await row.click();
  await expect
    .poll(
      () => {
        try {
          const parsed = parseAgentFromUrl(page.url());
          return `${parsed.serverId}:${parsed.agentId}`;
        } catch {
          return "";
        }
      },
      { timeout: 30000 }
    )
    .toBe(`${serverId}:${agentId}`);
}

async function openNewAgentDraft(page: Page): Promise<void> {
  await gotoHome(page);
  const newAgentButton = page.getByTestId("sidebar-new-agent").first();
  await expect(newAgentButton).toBeVisible({ timeout: 30000 });
  await newAgentButton.click();
  await expect(page).toHaveURL(/\/h\/[^/]+\/agent(\?|$)/, { timeout: 30000 });
  await expect(
    page.locator('[data-testid="working-directory-select"]:visible').first()
  ).toBeVisible({
    timeout: 30000,
  });
}

async function ensureExplorerTabsVisible(page: Page): Promise<void> {
  const filesTab = visibleTestId(page, "explorer-tab-files");
  if (await filesTab.isVisible().catch(() => false)) {
    return;
  }

  const toggle = page
    .getByRole("button", { name: /open explorer|close explorer|toggle explorer/i })
    .first();
  await expect(toggle).toBeVisible({ timeout: 10000 });
  await toggle.click();
  await expect(filesTab).toBeVisible({ timeout: 30000 });
}

async function openTerminalsPanel(page: Page): Promise<void> {
  await ensureExplorerTabsVisible(page);

  const terminalsTab = visibleTestId(page, "explorer-tab-terminals");
  await expect(terminalsTab).toBeVisible({ timeout: 30000 });
  await terminalsTab.click();

  await expect(visibleTestId(page, "terminals-header")).toBeVisible({
    timeout: 30000,
  });

  await expect(visibleTestId(page, "terminal-surface")).toBeVisible({
    timeout: 30000,
  });
}

async function openFilesPanel(page: Page): Promise<void> {
  await ensureExplorerTabsVisible(page);
  const filesTab = visibleTestId(page, "explorer-tab-files");
  await expect(filesTab).toBeVisible({ timeout: 30000 });
  await filesTab.click();
  await expect(visibleTestId(page, "files-pane-header")).toBeVisible({
    timeout: 30000,
  });
}

async function getDesktopAgentSidebarOpen(page: Page): Promise<boolean | null> {
  return await page.evaluate(() => {
    const raw = localStorage.getItem("panel-state");
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as {
        state?: { desktop?: { agentListOpen?: boolean } };
      };
      const value = parsed?.state?.desktop?.agentListOpen;
      return typeof value === "boolean" ? value : null;
    } catch {
      return null;
    }
  });
}


async function selectNewestTerminalTab(page: Page): Promise<void> {
  const tabs = visibleTestIdPrefix(page, "terminal-tab-");
  await expect(tabs.first()).toBeVisible({ timeout: 30000 });
  await expect
    .poll(async () => await tabs.count(), { timeout: 30000 })
    .toBeGreaterThanOrEqual(2);
  await tabs.last().click();
}

async function getFirstTerminalTabTestId(page: Page): Promise<string> {
  const firstTab = visibleTestIdPrefix(page, "terminal-tab-").first();
  await expect(firstTab).toBeVisible({ timeout: 30000 });
  const value = await firstTab.getAttribute("data-testid");
  if (!value) {
    throw new Error("Expected terminal tab test id");
  }
  return value;
}

async function runTerminalCommand(page: Page, command: string, expectedText: string): Promise<void> {
  const surface = visibleTestId(page, "terminal-surface");
  await expect(surface).toBeVisible({ timeout: 30000 });
  await surface.click({ force: true });
  await page.keyboard.type(command, { delay: 1 });
  await page.keyboard.press("Enter");
  await expect(surface).toContainText(expectedText, {
    timeout: 30000,
  });
}

async function runTerminalCommandWithPreEnterEcho(
  page: Page,
  command: string,
  expectedText: string
): Promise<void> {
  const surface = visibleTestId(page, "terminal-surface");
  await expect(surface).toBeVisible({ timeout: 30000 });
  await surface.click({ force: true });
  await page.keyboard.type(command, { delay: 1 });
  await expect(surface).toContainText(command, {
    timeout: 30000,
  });
  await page.keyboard.press("Enter");
  await expect(surface).toContainText(expectedText, {
    timeout: 30000,
  });
}

async function expectAnsiColorApplied(page: Page, marker: string): Promise<void> {
  await expect
    .poll(
      async () =>
        await page.evaluate((target) => {
          const terminal = (window as any).__paseoTerminal;
          if (!terminal?.buffer?.active?.getLine || !terminal?.buffer?.active?.getNullCell) {
            return false;
          }

          const buffer = terminal.buffer.active;
          const nullCell = buffer.getNullCell();
          const lineCount = buffer.length ?? 0;
          const cols = terminal.cols ?? 0;

          for (let y = 0; y < lineCount; y += 1) {
            const line = buffer.getLine(y);
            if (!line) continue;
            const lineText = line.translateToString(true);
            const index = lineText.indexOf(target);
            if (index === -1) continue;

            for (let x = index; x < index + target.length && x < cols; x += 1) {
              const cell = line.getCell(x, nullCell);
              if (!cell) continue;
              if (!cell.isFgDefault()) {
                return true;
              }
            }
          }
          return false;
        }, marker),
      { timeout: 30000 }
    )
    .toBe(true);
}

test("Terminals tab creates multiple terminals and streams command output", async ({ page }) => {
  const repo = await createTempGitRepo("paseo-e2e-terminals-");

  try {
    await openNewAgentDraft(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await createAgent(page, "Reply with exactly: terminal smoke");

    await openTerminalsPanel(page);
    await expect(visibleTestIdPrefix(page, "terminal-tab-").first()).toBeVisible({
      timeout: 30000,
    });

    const preEnterEchoMarker = shortTerminalMarker("typed");
    await runTerminalCommandWithPreEnterEcho(
      page,
      `echo ${preEnterEchoMarker}`,
      preEnterEchoMarker
    );

    const ansiMarker = `ansi-red-${Date.now()}`;
    await runTerminalCommand(
      page,
      `printf '\\033[31m${ansiMarker}\\033[0m\\n'`,
      ansiMarker
    );
    await expectAnsiColorApplied(page, ansiMarker);

    const markerOne = `terminal-smoke-one-${Date.now()}`;
    await runTerminalCommand(page, `echo ${markerOne}`, markerOne);

    await visibleTestId(page, "terminals-create-button").click();
    await selectNewestTerminalTab(page);

    const markerTwo = `terminal-smoke-two-${Date.now()}`;
    await runTerminalCommand(page, `echo ${markerTwo}`, markerTwo);
  } finally {
    await repo.cleanup();
  }
});

test("terminal reattaches cleanly after heavy output and tab switches", async ({ page }) => {
  const repo = await createTempGitRepo("paseo-e2e-terminal-reattach-");

  try {
    await openNewAgentDraft(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await createAgent(page, "hello");

    await openTerminalsPanel(page);
    await runTerminalCommand(
      page,
      "for i in $(seq 1 12000); do echo reattach-$i; done",
      "reattach-12000"
    );

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await openFilesPanel(page);
      await openTerminalsPanel(page);
      await expect(page.getByText("Terminal stream ended. Reconnecting…")).toHaveCount(0, {
        timeout: 30000,
      });
      await expect(page.locator('[data-testid="terminal-attach-loading"]:visible')).toHaveCount(0, {
        timeout: 30000,
      });
    }

    const marker = `reattach-health-${Date.now()}`;
    await runTerminalCommand(page, `echo ${marker}`, marker);
  } finally {
    await repo.cleanup();
  }
});

test("terminal keeps prompt echo visible after enter and backspace churn", async ({ page }) => {
  const repo = await createTempGitRepo("paseo-e2e-terminal-echo-churn-");

  try {
    await openNewAgentDraft(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await createAgent(page, "hello");

    await openTerminalsPanel(page);

    const surface = visibleTestId(page, "terminal-surface");
    await expect(surface).toBeVisible({ timeout: 30000 });
    await surface.click({ force: true });

    for (let iteration = 0; iteration < 40; iteration += 1) {
      await page.keyboard.press("Enter");
    }

    const markerAfterEnters = shortTerminalMarker("visible");
    await page.keyboard.type(`echo ${markerAfterEnters}`, { delay: 0 });
    await expect(surface).toContainText(`echo ${markerAfterEnters}`, {
      timeout: 30000,
    });
    await page.keyboard.press("Enter");
    await expect(surface).toContainText(markerAfterEnters, {
      timeout: 30000,
    });

    const longSuffix = "x".repeat(120);
    await page.keyboard.type(`echo ${longSuffix}`, { delay: 0 });
    for (let iteration = 0; iteration < longSuffix.length; iteration += 1) {
      await page.keyboard.press("Backspace");
    }

    const markerAfterBackspace = shortTerminalMarker("backspace");
    await page.keyboard.type(markerAfterBackspace, { delay: 0 });
    await page.keyboard.press("Enter");
    await expect(surface).toContainText(markerAfterBackspace, {
      timeout: 30000,
    });
  } finally {
    await repo.cleanup();
  }
});

test("terminal remains interactive after alternate-screen enter/exit", async ({ page }) => {
  const repo = await createTempGitRepo("paseo-e2e-terminal-alt-screen-");

  try {
    await openNewAgentDraft(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await createAgent(page, "hello");

    await openTerminalsPanel(page);

    const surface = visibleTestId(page, "terminal-surface");
    await expect(surface).toBeVisible({ timeout: 30000 });
    await surface.click({ force: true });

    await page.keyboard.type(
      "printf '\\033[?1049h\\033[2J\\033[HALT\\033[?1049l\\n'",
      { delay: 0 }
    );
    await page.keyboard.press("Enter");

    const marker = `post-alt-screen-${Date.now()}`;
    await page.keyboard.type(`echo ${marker}`, { delay: 0 });
    await page.keyboard.press("Enter");
    await expect(surface).toContainText(marker, {
      timeout: 30000,
    });
  } finally {
    await repo.cleanup();
  }
});

test("terminal tab is removed when shell exits", async ({ page }) => {
  const repo = await createTempGitRepo("paseo-e2e-terminal-exit-");

  try {
    await openNewAgentDraft(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await createAgent(page, "Terminal exit flow");

    await openTerminalsPanel(page);

    const exitedTabTestId = await getFirstTerminalTabTestId(page);

    const surface = visibleTestId(page, "terminal-surface");
    await expect(surface).toBeVisible({ timeout: 30000 });
    await surface.click({ force: true });
    await page.keyboard.type("exit", { delay: 1 });
    await page.keyboard.press("Enter");

    await expect(page.getByTestId(exitedTabTestId)).toHaveCount(0, {
      timeout: 30000,
    });

    await expect(visibleTestIdPrefix(page, "terminal-tab-").first()).toBeVisible({
      timeout: 30000,
    });
    const nextTabTestId = await getFirstTerminalTabTestId(page);
    expect(nextTabTestId).not.toBe(exitedTabTestId);
  } finally {
    await repo.cleanup();
  }
});

test("closing terminal with running command asks for confirmation", async ({ page }) => {
  const repo = await createTempGitRepo("paseo-e2e-terminal-close-confirm-");

  try {
    await openNewAgentDraft(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await createAgent(page, "Terminal close confirmation");

    await openTerminalsPanel(page);

    const tabTestId = await getFirstTerminalTabTestId(page);
    const terminalId = tabTestId.replace("terminal-tab-", "");
    const tab = visibleTestId(page, tabTestId);
    await expect(tab).toBeVisible({ timeout: 30000 });

    const runningMarker = `terminal-close-running-${Date.now()}`;
    await runTerminalCommand(
      page,
      `echo ${runningMarker} && sleep 30`,
      runningMarker
    );

    await tab.hover();
    const dialogPromise = page.waitForEvent("dialog", { timeout: 30000 }).then(
      async (dialog) => {
        expect(dialog.type()).toBe("confirm");
        await dialog.dismiss();
      }
    );
    await visibleTestId(page, `terminal-close-${terminalId}`).click();
    await dialogPromise;

    await expect(tab).toBeVisible({ timeout: 30000 });
  } finally {
    await repo.cleanup();
  }
});

test("confirming terminal close with running command removes the tab", async ({ page }) => {
  const repo = await createTempGitRepo("paseo-e2e-terminal-close-confirm-accept-");

  try {
    await openNewAgentDraft(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await createAgent(page, "Terminal close confirmation accept");

    await openTerminalsPanel(page);

    const tabTestId = await getFirstTerminalTabTestId(page);
    const terminalId = tabTestId.replace("terminal-tab-", "");
    const tab = visibleTestId(page, tabTestId);
    await expect(tab).toBeVisible({ timeout: 30000 });

    const runningMarker = `terminal-close-running-accept-${Date.now()}`;
    await runTerminalCommand(
      page,
      `echo ${runningMarker} && sleep 30`,
      runningMarker
    );

    await tab.hover();
    const dialogPromise = page.waitForEvent("dialog", { timeout: 30000 }).then(
      async (dialog) => {
        expect(dialog.type()).toBe("confirm");
        await dialog.accept();
      }
    );
    await visibleTestId(page, `terminal-close-${terminalId}`).click();
    await dialogPromise;

    await expect(page.getByTestId(tabTestId)).toHaveCount(0, {
      timeout: 30000,
    });
  } finally {
    await repo.cleanup();
  }
});


test("terminals are shared by agents on the same cwd", async ({ page }) => {
  const repo = await createTempGitRepo("paseo-e2e-terminal-share-");

  try {
    await openNewAgentDraft(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await createAgent(page, "Agent one");
    const first = parseAgentFromUrl(page.url());

    await openNewAgentDraft(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await createAgent(page, "Agent two");
    const second = parseAgentFromUrl(page.url());

    expect(first.serverId).toBe(second.serverId);
    expect(first.agentId).not.toBe(second.agentId);

    await openAgentFromSidebar(page, first.serverId, first.agentId);
    await openTerminalsPanel(page);
    await visibleTestId(page, "terminals-create-button").click();
    await selectNewestTerminalTab(page);

    await openAgentFromSidebar(page, second.serverId, second.agentId);
    await openTerminalsPanel(page);
    await selectNewestTerminalTab(page);

    const sharedMarker = `shared-terminal-${Date.now()}`;
    await runTerminalCommand(page, `echo ${sharedMarker}`, sharedMarker);

    await openAgentFromSidebar(page, first.serverId, first.agentId);
    await openTerminalsPanel(page);
    await selectNewestTerminalTab(page);
    await expect(visibleTestId(page, "terminal-surface")).toContainText(sharedMarker, {
      timeout: 30000,
    });
  } finally {
    await repo.cleanup();
  }
});

test("terminal captures escape and ctrl+c key input", async ({ page }) => {
  const repo = await createTempGitRepo("paseo-e2e-terminal-keys-");

  try {
    await openNewAgentDraft(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await createAgent(page, "Terminal key combo capture");

    await openTerminalsPanel(page);

    const surface = visibleTestId(page, "terminal-surface");
    await expect(surface).toBeVisible({ timeout: 30000 });
    await surface.click({ force: true });

    await page.keyboard.type("cat -v", { delay: 1 });
    await page.keyboard.press("Enter");
    await expect(surface).toContainText("cat -v", { timeout: 30000 });

    await page.keyboard.press("Escape");
    await expect(surface).toContainText("^[", { timeout: 30000 });

    await page.keyboard.press("Control+C");
    await expect(surface).toContainText("^C", { timeout: 30000 });

    await page.keyboard.press("Control+B");
    await expect(surface).toContainText("^B", { timeout: 30000 });

    // Clear any line-editor residue before validating the next shell command.
    await page.keyboard.press("Enter");
    const marker = shortTerminalMarker("key-capture");
    await page.keyboard.type(`echo ${marker}`, { delay: 1 });
    await page.keyboard.press("Enter");
    await expect(surface).toContainText(marker, { timeout: 30000 });
  } finally {
    await repo.cleanup();
  }
});

test("Cmd+B toggles sidebar even when terminal is focused", async ({ page }) => {
  const repo = await createTempGitRepo("paseo-e2e-terminal-cmd-b-");

  try {
    await openNewAgentDraft(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await createAgent(page, "Terminal Cmd+B");

    await openTerminalsPanel(page);
    const surface = visibleTestId(page, "terminal-surface");
    await expect(surface).toBeVisible({ timeout: 30000 });
    await surface.click({ force: true });

    await expect
      .poll(async () => await getDesktopAgentSidebarOpen(page), { timeout: 30000 })
      .toBe(true);

    await page.keyboard.press("Meta+B");
    await expect
      .poll(async () => await getDesktopAgentSidebarOpen(page), { timeout: 30000 })
      .toBe(false);

    await page.keyboard.press("Meta+B");
    await expect
      .poll(async () => await getDesktopAgentSidebarOpen(page), { timeout: 30000 })
      .toBe(true);
  } finally {
    await repo.cleanup();
  }
});

async function getTerminalRows(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const terminal = (window as { __paseoTerminal?: { rows?: unknown } }).__paseoTerminal;
    return typeof terminal?.rows === "number" ? terminal.rows : 0;
  });
}

async function setTerminalHeightInset(page: Page, inset: number): Promise<void> {
  await page.evaluate((nextPadding) => {
    const surfaces = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="terminal-surface"]')
    );
    const activeSurface =
      surfaces.find((surface) => surface.offsetParent !== null) ?? surfaces[0] ?? null;
    if (!activeSurface) {
      return;
    }
    const host = activeSurface.parentElement as HTMLElement | null;
    if (!host) {
      return;
    }
    if (nextPadding > 0) {
      host.style.flex = "0 0 auto";
      host.style.height = `calc(100% - ${nextPadding}px)`;
      return;
    }
    host.style.flex = "1 1 auto";
    host.style.height = "100%";
  }, inset);
}

async function getTerminalScrollbackDistance(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const terminal = (
      window as {
        __paseoTerminal?: {
          buffer?: { active?: { baseY?: unknown; viewportY?: unknown } };
        };
      }
    ).__paseoTerminal;
    const baseY = terminal?.buffer?.active?.baseY;
    const viewportY = terminal?.buffer?.active?.viewportY;
    if (typeof baseY !== "number" || typeof viewportY !== "number") {
      return 0;
    }
    return Math.max(0, baseY - viewportY);
  });
}

test("terminal viewport resizes and uses xterm scrollback", async ({ page }) => {
  const repo = await createTempGitRepo("paseo-e2e-terminal-viewport-");

  try {
    await openNewAgentDraft(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await createAgent(page, "Viewport and scrollback test");

    await openTerminalsPanel(page);

    const initialViewport = page.viewportSize();
    if (!initialViewport) {
      throw new Error("Expected a viewport size");
    }

    await expect
      .poll(() => getTerminalRows(page), { timeout: 30000 })
      .toBeGreaterThan(0);
    const initialRows = await getTerminalRows(page);

    await setTerminalHeightInset(page, 220);
    await expect
      .poll(() => getTerminalRows(page), { timeout: 30000 })
      .toBeLessThan(initialRows);

    await setTerminalHeightInset(page, 0);
    await expect
      .poll(() => getTerminalRows(page), { timeout: 30000 })
      .toBeGreaterThanOrEqual(initialRows);

    const reducedHeight = Math.max(520, initialViewport.height - 220);
    await page.setViewportSize({
      width: initialViewport.width,
      height: reducedHeight,
    });

    await expect
      .poll(() => getTerminalRows(page), { timeout: 30000 })
      .toBeLessThan(initialRows);

    await page.setViewportSize(initialViewport);

    await expect
      .poll(() => getTerminalRows(page), { timeout: 30000 })
      .toBeGreaterThanOrEqual(initialRows);

    const scrollbackMarker = `scrollback-${Date.now()}`;
    await runTerminalCommand(
      page,
      `for i in $(seq 1 180); do echo ${scrollbackMarker}-$i; done`,
      `${scrollbackMarker}-180`
    );

    const surface = visibleTestId(page, "terminal-surface");
    await surface.hover();
    await page.mouse.wheel(0, -3000);

    await expect
      .poll(() => getTerminalScrollbackDistance(page), { timeout: 30000 })
      .toBeGreaterThan(0);

    const distanceAfterScrollUp = await getTerminalScrollbackDistance(page);

    await surface.hover();
    await page.mouse.wheel(0, 3000);

    await expect
      .poll(() => getTerminalScrollbackDistance(page), { timeout: 30000 })
      .toBeLessThan(distanceAfterScrollUp);
  } finally {
    await repo.cleanup();
  }
});
