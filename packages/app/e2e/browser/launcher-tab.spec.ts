import { test, expect } from "../support/fixtures";
import {
  gotoWorkspace,
  assertNewChatTileVisible,
  assertNewTabMenuTriggerVisible,
  assertSingleNewTabButton,
  openNewTabMenuWithShortcut,
  pressDirectNewTabShortcut,
  clickNewChat,
  clickNewTerminal,
  countTabsOfKind,
  waitForTabBar,
  pressNewTabShortcut,
  getTabTestIds,
  waitForTabWithTitle,
  measureTileTransition,
  sampleTabsDuringTransition,
  expectTabTitleFits,
  terminalSurfaceLocator,
} from "../support/helpers/launcher";
import { expectComposerVisible, composerLocator } from "../support/helpers/composer";
import {
  expectTerminalSurfaceVisible,
  setupDeterministicPrompt,
} from "../support/helpers/terminal-perf";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import {
  expectTerminalOutputContains,
  seedTerminalProfiles,
  type TerminalProfile,
} from "../support/helpers/new-workspace-launch";
import { gotoAppShell } from "../support/helpers/app";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { getServerId } from "../support/helpers/server-id";

// ─── Shared state ──────────────────────────────────────────────────────────

let workspace: SeededWorkspace;
let secondWorkspaceId: string | null = null;

const EMPTY_PROMPT_PROFILE: TerminalProfile = {
  id: "e2e-empty-prompt",
  name: "Empty Prompt",
  command: "/bin/sh",
  args: ["-c", 'echo prompt-args: "$#"; sleep 10', "profile-name", "{{{prompt}}}"],
};

test.beforeAll(async () => {
  workspace = await seedWorkspace({ repoPrefix: "launcher-e2e-" });
  const created = await workspace.client.createWorkspace({
    source: { kind: "directory", path: workspace.repoPath, projectId: workspace.projectId },
    title: "launcher-e2e-cmd-t-switch-target",
  });
  if (!created.workspace) {
    throw new Error(created.error ?? "Failed to create secondary workspace for cmd+t switch test");
  }
  secondWorkspaceId = created.workspace.id;
});

test.afterAll(async () => {
  await workspace?.cleanup();
});

// ═══════════════════════════════════════════════════════════════════════════
// Tab Creation Tests
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Tab creation", () => {
  test("Cmd+T keeps opening the New tab menu after workspace switches", async ({ page }) => {
    if (!secondWorkspaceId) {
      throw new Error("Secondary workspace was not created");
    }

    const serverId = getServerId();
    const newTabMenuItem = page.getByRole("menuitem", { name: /^Agent/ });

    const switchWorkspaceRow = async (workspaceId: string) => {
      const row = page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceId}`).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.click();
      // The shortcut must follow the route, so prove the route actually moved first.
      await expect(page).toHaveURL(new RegExp(`workspace/${workspaceId}(\\b|/|$)`), {
        timeout: 15_000,
      });
      await waitForTabBar(page);
    };

    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    const sequence = [workspace.workspaceId, secondWorkspaceId];
    for (let i = 0; i < 8; i++) {
      await switchWorkspaceRow(sequence[i % sequence.length]);
      await pressNewTabShortcut(page);
      await expect(newTabMenuItem, `New tab menu did not open after switch ${i}`).toBeVisible({
        timeout: 5_000,
      });
      await page.keyboard.press("Escape");
      await expect(newTabMenuItem).toBeHidden({ timeout: 5_000 });
    }
  });

  test("retained inactive workspaces cannot own New tab shortcuts", async ({ page }) => {
    await gotoWorkspace(page, workspace.workspaceId);
    const workspaceUrl = page.url();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";

    await page.keyboard.press(`${modifier}+Comma`);
    await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible();

    await page.keyboard.press(`${modifier}+t`);
    await expect(page.getByRole("menuitem", { name: /^Agent/ })).toHaveCount(0);

    await page.goto(workspaceUrl);
    await assertNewTabMenuTriggerVisible(page);
    const countBefore = await countTabsOfKind(page, "draft");
    await pressDirectNewTabShortcut(page, "a");
    await expect.poll(() => countTabsOfKind(page, "draft")).toBe(countBefore + 1);
  });

  test("Cmd+T opens the New tab menu without creating an agent", async ({ page }) => {
    await gotoWorkspace(page, workspace.workspaceId);
    const countBefore = await countTabsOfKind(page, "draft");

    await openNewTabMenuWithShortcut(page);

    await expect.poll(() => countTabsOfKind(page, "draft")).toBe(countBefore);
    await expect(page.getByRole("button", { name: "New tab", expanded: true })).toBeVisible();
  });

  test("opening two new tabs creates two draft tabs", async ({ page }) => {
    await gotoWorkspace(page, workspace.workspaceId);

    const countBefore = await countTabsOfKind(page, "draft");

    await pressDirectNewTabShortcut(page, "a");
    await expect
      .poll(() => countTabsOfKind(page, "draft"), { timeout: 15_000 })
      .toBe(countBefore + 1);
    const countAfterFirst = await countTabsOfKind(page, "draft");

    await pressDirectNewTabShortcut(page, "a");
    await expect
      .poll(() => countTabsOfKind(page, "draft"), { timeout: 15_000 })
      .toBe(countAfterFirst + 1);
  });

  test("New tab menu exposes shortcuts and supports arrow navigation", async ({ page }) => {
    await gotoWorkspace(page, workspace.workspaceId);
    await openNewTabMenuWithShortcut(page);

    const agent = page.getByRole("menuitem", { name: /^Agent/ });
    const terminal = page.getByRole("menuitem", { name: /^Terminal/ });
    const changes = page.getByRole("menuitem", { name: /Changes/ });
    const files = page.getByRole("menuitem", { name: /Files/ });
    const shortcutPrefix = process.platform === "darwin" ? /⇧⌘/ : /Ctrl.*Shift/;
    await expect(agent).toContainText(new RegExp(`${shortcutPrefix.source}.*A`));
    await expect(terminal).toContainText(new RegExp(`${shortcutPrefix.source}.*T`));
    await expect(changes).toContainText(new RegExp(`${shortcutPrefix.source}.*C`));
    await expect(files).toContainText(new RegExp(`${shortcutPrefix.source}.*E`));
    await expect(agent).toBeFocused();

    await page.keyboard.press("ArrowDown");
    await expect(terminal).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(agent).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "New tab" })).toBeFocused();
    await expect(page.getByRole("button", { name: "New tab" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  test("clicking new agent tab creates a draft tab", async ({ page }) => {
    await gotoWorkspace(page, workspace.workspaceId);

    await clickNewChat(page);

    await expectComposerVisible(page);

    const tabsAfter = await getTabTestIds(page);
    const draftCountAfter = tabsAfter.filter((id) => id.includes("draft")).length;
    expect(draftCountAfter).toBeGreaterThanOrEqual(1);
  });

  test("clicking terminal button creates a standalone terminal", async ({ page }) => {
    test.setTimeout(45_000);
    await gotoWorkspace(page, workspace.workspaceId);

    await clickNewTerminal(page);

    await expectTerminalSurfaceVisible(page);

    const tabsAfter = await getTabTestIds(page);
    const terminalTabs = tabsAfter.filter((id) => id.includes("terminal"));
    expect(terminalTabs.length).toBeGreaterThanOrEqual(1);
  });

  test("launching a profile from the New tab menu drops its empty prompt argument", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    const profileSeed = await seedTerminalProfiles([EMPTY_PROMPT_PROFILE]);

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await page.getByTestId("workspace-new-tab-menu-trigger").filter({ visible: true }).click();
      await page.getByRole("menuitem", { name: EMPTY_PROMPT_PROFILE.name }).click();

      await expectTerminalOutputContains(page, "prompt-args: 0");
    } finally {
      await profileSeed.restore();
    }
  });

  test("tab bar shows action buttons per pane", async ({ page }) => {
    await gotoWorkspace(page, workspace.workspaceId);
    await assertSingleNewTabButton(page);
    await assertNewChatTileVisible(page);
    await assertNewTabMenuTriggerVisible(page);
  });

  test("never shades the New tab button", async ({ page }) => {
    await gotoWorkspace(page, workspace.workspaceId);

    const tabRow = page.getByTestId("workspace-tabs-row").filter({ visible: true }).first();
    const scrollArea = tabRow.getByTestId("workspace-tabs-scroll");
    const newTabButtonInScroll = await scrollArea
      .getByTestId("workspace-new-tab-menu-trigger")
      .count();
    const scrollShades = await tabRow
      .locator('[data-testid^="workspace-tabs-scroll-shade-"]')
      .count();

    expect(newTabButtonInScroll === 0 || scrollShades === 0).toBe(true);
    await expect(tabRow.getByTestId("workspace-new-tab-menu-trigger")).toBeVisible();
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

  test.skip("terminal tab title updates from OSC title escape sequence", async ({ page }) => {
    test.setTimeout(60_000);

    const result = await workspace.client.createTerminal(
      workspace.repoPath,
      "title-test",
      undefined,
      {
        workspaceId: workspace.workspaceId,
      },
    );
    if (!result.terminal) throw new Error(`Failed to create terminal: ${result.error}`);
    const terminalId = result.terminal.id;

    try {
      // Navigate to workspace and open a terminal
      await gotoWorkspace(page, workspace.workspaceId);
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
      await workspace.client.killTerminal(terminalId).catch(() => {});
    }
  });

  test.skip("title debouncing coalesces rapid changes", async ({ page }) => {
    test.setTimeout(60_000);

    const result = await workspace.client.createTerminal(
      workspace.repoPath,
      "debounce-test",
      undefined,
      {
        workspaceId: workspace.workspaceId,
      },
    );
    if (!result.terminal) throw new Error(`Failed to create terminal: ${result.error}`);
    const terminalId = result.terminal.id;

    try {
      await gotoWorkspace(page, workspace.workspaceId);
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
      await workspace.client.killTerminal(terminalId).catch(() => {});
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// No-Flash Transition Tests
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Tab transitions (no flash)", () => {
  test("New agent tab transition has no blank intermediate tab state", async ({ page }) => {
    await gotoWorkspace(page, workspace.workspaceId);

    // Sample tabs at high frequency across the transition
    const snapshots = await sampleTabsDuringTransition(page, () => clickNewChat(page));

    // Every snapshot should have at least one tab — no blank/zero-tab frames
    for (const snapshot of snapshots) {
      expect(snapshot.length).toBeGreaterThanOrEqual(1);
    }

    // Tab count should never spike excessively (no duplicate flash from add-then-remove).
    // When running in-suite, previous tests may have created tabs on the shared workspace,
    // so we allow +2 tolerance for accumulated state and React render batching.
    const counts = snapshots.map((snapshot) => snapshot.length);
    const maxCount = Math.max(...counts);
    const initialCount = counts[0] ?? 0;

    expect(maxCount).toBeLessThanOrEqual(initialCount + 2);
    expect(new Set(snapshots.map((snapshot) => JSON.stringify(snapshot))).size).toBeLessThanOrEqual(
      2,
    );
    await expectTabTitleFits(page, "New Agent", { min: 96, max: 160 });
  });

  test("Terminal transition completes within visual budget", async ({ page }) => {
    test.setTimeout(30_000);
    await gotoWorkspace(page, workspace.workspaceId);

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
    await gotoWorkspace(page, workspace.workspaceId);

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
