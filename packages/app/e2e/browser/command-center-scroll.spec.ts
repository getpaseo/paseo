import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { getServerId } from "../support/helpers/server-id";
import {
  seedSearchableCommandCenter,
  observeCommandCenterRowRenders,
  searchCommandCenter,
  warmCommandCenterRows,
  expectOnlyCommandCenterRowRendered,
  expectCommandCenterWorkspaceWindow,
  scrollToOldestCommandCenterWorkspace,
} from "../support/helpers/command-center-performance";
import { gotoAppShell } from "../support/helpers/app";
import {
  expectCommandCenterToRemainAtTheTop,
  scrollCommandCenterAwayFromSelection,
  expectCommandCenterScrollToStayAt,
  expectKeyboardNavigationToResume,
  expectPrimaryCommandCenterActions,
  expectTightTwoLineResultSpacing,
  expectVisibleKeyboardNavigationNotToScroll,
  expectRecentWorkspacesUntilSearch,
  observeCommandCenterScroll,
  openCommandCenterWithKeyboard,
} from "../support/helpers/command-center-scroll";
import { seedWorkspace } from "../support/helpers/seed-client";

test.use({
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/145.0 Safari/537.36",
});

test("Command Center preserves manual scrolling through live updates and resumes keyboard navigation", async ({
  page,
}) => {
  const seeded = await seedWorkspace({
    repoPrefix: "command-center-scroll-",
    title: "Command Center Scroll 00",
  });

  let newestWorkspaceId = seeded.workspaceId;
  try {
    for (let index = 1; index <= 8; index += 1) {
      const created = await seeded.client.createWorkspace({
        source: {
          kind: "worktree",
          projectId: seeded.projectId,
          baseBranch: "main",
          worktreeSlug: `command-center-scroll-${index}`,
        },
        title: `Command Center Scroll ${String(index).padStart(2, "0")}`,
      });
      if (!created.workspace) {
        throw new Error(created.error ?? `Failed to seed workspace ${index}`);
      }
      newestWorkspaceId = created.workspace.id;
    }

    await gotoAppShell(page);
    await observeCommandCenterScroll(page);
    const panel = await openCommandCenterWithKeyboard(page);

    await expectCommandCenterToRemainAtTheTop(page);
    await expectPrimaryCommandCenterActions(panel);
    await expectVisibleKeyboardNavigationNotToScroll(page, panel);
    // All leads with the most recent workspaces, so the last one seeded leads it.
    await expectTightTwoLineResultSpacing(panel, "Command Center Scroll 08");
    await expectRecentWorkspacesUntilSearch(panel);
    const offset = await scrollCommandCenterAwayFromSelection(page, panel);
    await seeded.client.setWorkspaceTitle(newestWorkspaceId, "Command Center Scroll renamed");
    await expect(panel.getByText("Command Center Scroll renamed", { exact: true })).toHaveCount(1);
    await expectCommandCenterScrollToStayAt(panel, offset);
    await expectKeyboardNavigationToResume(page, panel, offset);
  } finally {
    await seeded.cleanup();
  }
});

test("live search updates render only the changed row and keep workspaces virtualized", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seeded = await seedSearchableCommandCenter();
  const agentWorkspaceRowId = `workspace:${getServerId()}:${seeded.workspaceId}`;
  try {
    await observeCommandCenterRowRenders(page);
    await gotoAppShell(page);
    const panel = await openCommandCenterWithKeyboard(page);

    await test.step("renaming a matched agent re-renders only its workspace", async () => {
      await searchCommandCenter(panel, "Search agent 002");
      const agentLine = panel
        .getByTestId(`command-center-workspace-${getServerId()}:${seeded.workspaceId}`)
        .getByTestId("command-center-workspace-agent");
      await expect(agentLine).toHaveText("Search agent 002");
      await warmCommandCenterRows(page);
      await seeded.client.updateAgent(seeded.agents[2].id, { name: "Search agent 002 revised" });
      await expect(agentLine).toHaveText("Search agent 002 revised");
      await expectOnlyCommandCenterRowRendered(page, agentWorkspaceRowId);
    });

    await test.step("renaming a workspace re-renders only its row", async () => {
      await searchCommandCenter(panel, "Search workspace");
      await expect(panel.getByText("Search workspace 039", { exact: true })).toBeVisible();
      await warmCommandCenterRows(page);
      await seeded.client.setWorkspaceTitle(
        seeded.workspaces[39].id,
        "Search workspace 039 revised",
      );
      await expect(panel.getByText("Search workspace 039 revised", { exact: true })).toBeVisible();
      await expectOnlyCommandCenterRowRendered(
        page,
        `workspace:${getServerId()}:${seeded.workspaces[39].id}`,
      );
    });

    await test.step("a long list mounts only a window of rows", async () => {
      await expectCommandCenterWorkspaceWindow(panel, seeded.workspaces.length + 1);
      await scrollToOldestCommandCenterWorkspace(panel);
      await expect(panel.getByText("Search workspace 000", { exact: true })).toBeVisible();
      await expectCommandCenterWorkspaceWindow(panel, seeded.workspaces.length + 1);
    });
  } finally {
    await seeded.cleanup();
  }
});
