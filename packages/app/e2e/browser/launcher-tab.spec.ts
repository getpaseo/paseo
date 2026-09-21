import { test, expect } from "../support/fixtures";
import type { Locator } from "@playwright/test";
import {
  gotoWorkspace,
  assertNewChatTileVisible,
  assertNewTabMenuTriggerVisible,
  assertSingleNewTabButton,
  openNewTabMenuWithShortcut,
  clickNewChat,
  clickNewTerminal,
  countTabsOfKind,
  waitForTabBar,
  pressNewTabShortcut,
  pressDirectNewTabShortcut,
  getTabTestIds,
  measureTileTransition,
  sampleTabsDuringTransition,
  expectTabTitleFits,
  terminalSurfaceLocator,
} from "../support/helpers/launcher";
import { expectComposerVisible, composerLocator } from "../support/helpers/composer";
import { expectTerminalSurfaceVisible } from "../support/helpers/terminal-perf";
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
  args: ["-c", 'echo prompt-args: "$#"; exec cat', "profile-name", "{{{prompt}}}"],
};

async function tabTestIds(tabs: Locator): Promise<(string | null)[]> {
  return tabs.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-testid")),
  );
}

function tabIdentityKey(snapshot: Array<{ id: string }>): string {
  return JSON.stringify(snapshot.map(({ id }) => id));
}

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
  test("Cmd+T keeps creating a New tab after workspace switches", async ({ page }) => {
    if (!secondWorkspaceId) {
      throw new Error("Secondary workspace was not created");
    }

    const serverId = getServerId();
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
      await expect(
        page.getByTestId("workspace-new-tab-panel").filter({ visible: true }),
        `New tab did not open after switch ${i}`,
      ).toBeVisible({
        timeout: 5_000,
      });
    }
  });

  test("retained inactive workspaces cannot own New tab shortcuts", async ({ page }) => {
    await gotoWorkspace(page, workspace.workspaceId);
    const workspaceUrl = page.url();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    const newTabCountBefore = await countTabsOfKind(page, "new_tab");

    await page.keyboard.press(`${modifier}+Comma`);
    await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible();

    await page.keyboard.press(`${modifier}+t`);

    await page.goto(workspaceUrl);
    await assertNewTabMenuTriggerVisible(page);
    await expect.poll(() => countTabsOfKind(page, "new_tab")).toBe(newTabCountBefore);
  });

  test("opens the menu, then creates independent New tabs without creating agents", async ({
    page,
  }) => {
    await gotoWorkspace(page, workspace.workspaceId);
    await pressNewTabShortcut(page);
    const newTabs = page
      .locator('[data-testid^="workspace-tab-tab_"]')
      .filter({ hasText: "New tab" });
    await expect(newTabs.first()).toBeVisible();
    const countBefore = await newTabs.count();
    const draftCount = await countTabsOfKind(page, "draft");

    await test.step("opening the plus menu leaves the current tabs intact", async () => {
      await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).click();
      await expect(
        page.getByTestId("workspace-new-tab-menu").filter({ visible: true }),
      ).toBeVisible();
      await expect(newTabs).toHaveCount(countBefore);
      await page.keyboard.press("Escape");
    });
    await test.step("two shortcuts open two independent launchers", async () => {
      await pressNewTabShortcut(page);
      await expect(newTabs).toHaveCount(countBefore + 1);
      const firstIds = await tabTestIds(newTabs);
      await pressNewTabShortcut(page);
      await expect(newTabs).toHaveCount(countBefore + 2);
      const ids = await tabTestIds(newTabs);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(expect.arrayContaining(firstIds));
      expect(await countTabsOfKind(page, "draft")).toBe(draftCount);
      await expect(
        page.getByTestId("workspace-new-tab-panel").filter({ visible: true }),
      ).toBeVisible();
    });
  });

  test("New tab exposes shortcuts and supports arrow navigation after refocus", async ({
    page,
  }) => {
    await gotoWorkspace(page, workspace.workspaceId);
    await openNewTabMenuWithShortcut(page);

    const panel = page.getByTestId("workspace-new-tab-panel").filter({ visible: true });
    const agent = panel.getByRole("button", { name: /^Agent/ });
    const terminal = panel.getByRole("button", { name: /^Terminal/ });
    const diff = panel.getByRole("button", { name: /Diff/ });
    const shortcutPrefix = process.platform === "darwin" ? /⇧⌘/ : /Ctrl.*Shift/;
    await expect(agent).toContainText(new RegExp(`${shortcutPrefix.source}.*A`));
    await expect(terminal).toContainText(new RegExp(`${shortcutPrefix.source}.*T`));
    await expect(diff).toContainText(new RegExp(`${shortcutPrefix.source}.*G`));
    await expect(agent).toBeFocused();

    await page.keyboard.press("ArrowDown");
    await expect(terminal).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(agent).toBeFocused();

    await pressDirectNewTabShortcut(page, "e");
    await expect(page.getByTestId("workspace-explorer-sidebar")).toBeVisible();
    await expect(
      page.getByTestId("file-explorer-tree-scroll").filter({ visible: true }),
    ).toBeVisible();

    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await panel.click({ position: { x: 20, y: 20 } });
    await expect(agent).toBeFocused();
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
      await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).click();
      await page
        .getByTestId("workspace-new-tab-menu")
        .filter({ visible: true })
        .getByRole("menuitem", { name: EMPTY_PROMPT_PROFILE.name })
        .click();

      await expectTerminalOutputContains(page, "prompt-args: 0");
    } finally {
      await profileSeed.restore();
    }
  });

  test("terminal profiles are grouped with a settings action", async ({ page }) => {
    await gotoWorkspace(page, workspace.workspaceId);
    await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).click();

    const menu = page.getByTestId("workspace-new-tab-menu").filter({ visible: true });
    await expect(menu.getByText("Terminal profiles", { exact: true })).toBeVisible();

    const editProfiles = menu.getByTestId("workspace-new-tab-menu-edit-terminal-profiles");
    await expect(editProfiles).toHaveAccessibleName("Edit profiles");

    await editProfiles.click();
    await expect(page).toHaveURL(/\/settings\/hosts\/[^/]+\/terminals$/);
  });

  test("tab bar shows action buttons per pane", async ({ page }) => {
    await gotoWorkspace(page, workspace.workspaceId);
    await assertSingleNewTabButton(page);
    await assertNewChatTileVisible(page);
    await assertNewTabMenuTriggerVisible(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// No-Flash Transition Tests
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Tab transitions (no flash)", () => {
  test("New agent tab transition has no blank intermediate tab state", async ({
    page,
    withWorkspace,
  }) => {
    const isolatedWorkspace = await withWorkspace({ prefix: "launcher-no-flash-" });
    await isolatedWorkspace.navigateTo();
    await pressNewTabShortcut(page);
    await expect(
      page.getByTestId("workspace-new-tab-panel").filter({ visible: true }),
    ).toBeVisible();

    // Sample the single New → Agent replacement, not the separate action that
    // creates the New tab in the first place.
    const snapshots = await sampleTabsDuringTransition(page, async () => {
      await page.getByTestId("workspace-new-tab-agent").filter({ visible: true }).first().click();
    });

    // Every snapshot should have at least one tab — no blank/zero-tab frames
    for (const snapshot of snapshots) {
      expect(snapshot.length).toBeGreaterThanOrEqual(1);
    }

    // Replacement is atomic: the set of identities changes once, while its size stays fixed.
    const counts = snapshots.map((snapshot) => snapshot.length);
    const initialCount = counts[0] ?? 0;

    expect(counts.every((count) => count === initialCount)).toBe(true);
    expect(new Set(snapshots.map(tabIdentityKey)).size).toBeLessThanOrEqual(2);
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
