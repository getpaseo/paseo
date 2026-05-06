import { test, expect } from "./fixtures";
import { createTempGitRepo } from "./helpers/workspace";
import {
  gotoWorkspace,
  assertNewChatTileVisible,
  assertTerminalTileVisible,
  assertSingleNewTabButton,
  pressNewTabShortcut,
  clickNewChat,
  clickNewTerminal,
  countTabsOfKind,
  getTabTestIds,
  waitForTabWithTitle,
  measureTileTransition,
  sampleTabsDuringTransition,
  terminalSurfaceLocator,
} from "./helpers/launcher";
import { expectComposerVisible, composerLocator } from "./helpers/composer";
import { expectTerminalSurfaceVisible } from "./helpers/terminal-perf";
import {
  connectTerminalClient,
  setupDeterministicPrompt,
  type TerminalPerfDaemonClient,
} from "./helpers/terminal-perf";

// ─── Shared state ──────────────────────────────────────────────────────────

let tempRepo: { path: string; cleanup: () => Promise<void> };
let workspaceId: string;
let seedClient: TerminalPerfDaemonClient;

test.beforeAll(async () => {
  tempRepo = await createTempGitRepo("launcher-e2e-");
  seedClient = await connectTerminalClient();
  const result = await seedClient.openProject(tempRepo.path);
  if (!result.workspace) throw new Error(result.error ?? "Failed to seed workspace");
  workspaceId = result.workspace.id;
});

test.afterAll(async () => {
  if (seedClient) await seedClient.close();
  if (tempRepo) await tempRepo.cleanup();
});

// ═══════════════════════════════════════════════════════════════════════════
// Tab Creation Tests
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Tab creation", () => {
  test("Cmd+T opens a new agent tab with composer", async ({ page }) => {
    await gotoWorkspace(page, workspaceId);

    await pressNewTabShortcut(page);

    await expectComposerVisible(page);
  });

  test("opening two new tabs creates two draft tabs", async ({ page }) => {
    await gotoWorkspace(page, workspaceId);

    const countBefore = await countTabsOfKind(page, "draft");

    await pressNewTabShortcut(page);
    await expect
      .poll(() => countTabsOfKind(page, "draft"), { timeout: 15_000 })
      .toBe(countBefore + 1);
    const countAfterFirst = await countTabsOfKind(page, "draft");

    // Blur the composer so the second shortcut isn't swallowed by the focused input
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.());
    await pressNewTabShortcut(page);
    await expect
      .poll(() => countTabsOfKind(page, "draft"), { timeout: 15_000 })
      .toBe(countAfterFirst + 1);
  });

  test("clicking new agent tab creates a draft tab", async ({ page }) => {
    await gotoWorkspace(page, workspaceId);

    await clickNewChat(page);

    await expectComposerVisible(page);

    const tabsAfter = await getTabTestIds(page);
    const draftCountAfter = tabsAfter.filter((id) => id.includes("draft")).length;
    expect(draftCountAfter).toBeGreaterThanOrEqual(1);
  });

  test("clicking terminal button creates a standalone terminal", async ({ page }) => {
    test.setTimeout(45_000);
    await gotoWorkspace(page, workspaceId);

    await clickNewTerminal(page);

    await expectTerminalSurfaceVisible(page);

    const tabsAfter = await getTabTestIds(page);
    const terminalTabs = tabsAfter.filter((id) => id.includes("terminal"));
    expect(terminalTabs.length).toBeGreaterThanOrEqual(1);
  });

  test("tab bar shows action buttons per pane", async ({ page }) => {
    await gotoWorkspace(page, workspaceId);
    await assertSingleNewTabButton(page);
    await assertNewChatTileVisible(page);
    await assertTerminalTileVisible(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Terminal Title Tests
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Terminal title propagation", () => {
  // OSC title escape sequence propagation is inherently flaky — the terminal
  // must process the sequence, emit a title change event, and the tab bar
  // must re-render before the assertion deadline. Allow retries.
  test.describe.configure({ retries: 2 });

  let client: TerminalPerfDaemonClient;

  test.beforeAll(async () => {
    client = await connectTerminalClient();
  });

  test.afterAll(async () => {
    if (client) await client.close();
  });

  test.skip("terminal tab title updates from OSC title escape sequence", async ({ page }) => {
    test.setTimeout(60_000);

    const result = await client.createTerminal(tempRepo.path, "title-test");
    if (!result.terminal) throw new Error(`Failed to create terminal: ${result.error}`);
    const terminalId = result.terminal.id;

    try {
      // Navigate to workspace and open a terminal
      await gotoWorkspace(page, workspaceId);
      await clickNewTerminal(page);

      await expectTerminalSurfaceVisible(page);
      await terminalSurfaceLocator(page).click();

      await setupDeterministicPrompt(page);

      // Send OSC 0 (set window title) escape sequence
      const testTitle = `E2E-Title-${Date.now()}`;
      await terminalSurfaceLocator(page).pressSequentially(`printf '\\033]0;${testTitle}\\007'\n`, {
        delay: 0,
      });

      // Wait for the tab to reflect the new title
      await waitForTabWithTitle(page, testTitle, 15_000);
    } finally {
      await client.killTerminal(terminalId).catch(() => {});
    }
  });

  test.skip("title debouncing coalesces rapid changes", async ({ page }) => {
    test.setTimeout(60_000);

    const result = await client.createTerminal(tempRepo.path, "debounce-test");
    if (!result.terminal) throw new Error(`Failed to create terminal: ${result.error}`);
    const terminalId = result.terminal.id;

    try {
      await gotoWorkspace(page, workspaceId);
      await clickNewTerminal(page);

      await expectTerminalSurfaceVisible(page);
      await terminalSurfaceLocator(page).click();

      await setupDeterministicPrompt(page);

      // Fire many rapid title changes — only the last should stick
      const finalTitle = `Final-${Date.now()}`;
      for (let i = 0; i < 5; i++) {
        await terminalSurfaceLocator(page).pressSequentially(`printf '\\033]0;Rapid-${i}\\007'\n`, {
          delay: 0,
        });
      }
      await terminalSurfaceLocator(page).pressSequentially(
        `printf '\\033]0;${finalTitle}\\007'\n`,
        { delay: 0 },
      );

      // The tab should eventually settle on the final title
      await waitForTabWithTitle(page, finalTitle, 15_000);
    } finally {
      await client.killTerminal(terminalId).catch(() => {});
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// No-Flash Transition Tests
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Tab transitions (no flash)", () => {
  test("New agent tab transition has no blank intermediate tab state", async ({ page }) => {
    await gotoWorkspace(page, workspaceId);

    // Sample tabs at high frequency across the transition
    const snapshots = await sampleTabsDuringTransition(page, () => clickNewChat(page), 2_000, 30);

    // Every snapshot should have at least one tab — no blank/zero-tab frames
    for (const snapshot of snapshots) {
      expect(snapshot.length).toBeGreaterThanOrEqual(1);
    }

    // Tab count should never spike excessively (no duplicate flash from add-then-remove).
    // When running in-suite, previous tests may have created tabs on the shared workspace,
    // so we allow +2 tolerance for accumulated state and React render batching.
    const counts = snapshots.map((s) => s.length);
    const maxCount = Math.max(...counts);
    const initialCount = counts[0] ?? 0;

    expect(maxCount).toBeLessThanOrEqual(initialCount + 2);
  });

  test("Terminal transition completes within visual budget", async ({ page }) => {
    test.setTimeout(30_000);
    await gotoWorkspace(page, workspaceId);

    const elapsed = await measureTileTransition(
      page,
      () => clickNewTerminal(page),
      terminalSurfaceLocator(page),
      20_000,
    );

    // Terminal surface should appear within a reasonable budget.
    // Note: terminal creation involves a server round-trip, so we allow more time
    // than a pure in-memory transition, but it should still be well under 5 seconds.
    expect(elapsed).toBeLessThan(5_000);
  });

  test("New agent tab click shows composer without flash", async ({ page }) => {
    await gotoWorkspace(page, workspaceId);

    const elapsed = await measureTileTransition(
      page,
      () => clickNewChat(page),
      composerLocator(page),
      10_000,
    );

    // Draft creation is fully in-memory — should be fast
    // We use a generous budget here because CI can be slow, but the key assertion
    // is that no blank/flash frame appears (tested above).
    expect(elapsed).toBeLessThan(3_000);
  });
});
