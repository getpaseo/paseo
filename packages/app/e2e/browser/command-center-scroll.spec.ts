import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { getServerId } from "../support/helpers/server-id";
import {
  seedSearchableCommandCenter,
  observeCommandCenterRowRenders,
  searchCommandCenter,
  warmCommandCenterRows,
  expectOnlyCommandCenterRowRendered,
  expectCommandCenterAgentWindow,
  scrollToOldestCommandCenterAgent,
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
  expectWorkspaceResultsToBeLimitedUntilSearch,
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
    // The empty query lists the most recent workspaces, so the last one seeded leads it.
    await expectTightTwoLineResultSpacing(panel, "Command Center Scroll 08");
    await expectWorkspaceResultsToBeLimitedUntilSearch(panel);
    const offset = await scrollCommandCenterAwayFromSelection(page, panel);
    await seeded.client.setWorkspaceTitle(newestWorkspaceId, "Command Center Scroll renamed");
    await expect(panel.getByText("Command Center Scroll renamed", { exact: true })).toHaveCount(1);
    await expectCommandCenterScrollToStayAt(panel, offset);
    await expectKeyboardNavigationToResume(page, panel, offset);
  } finally {
    await seeded.cleanup();
  }
});

test("live search updates render only the changed row and keep agents virtualized", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seeded = await seedSearchableCommandCenter();
  try {
    await observeCommandCenterRowRenders(page);
    await gotoAppShell(page);
    const panel = await openCommandCenterWithKeyboard(page);
    await searchCommandCenter(panel, "Search agent");
    await expect(panel.getByText("Search agent 059", { exact: true })).toBeVisible();
    await warmCommandCenterRows(page);
    await expectCommandCenterAgentWindow(panel, seeded.agents.length);

    await seeded.client.updateAgent(seeded.agents[59].id, { name: "Search agent 059 revised" });
    await expect(panel.getByText("Search agent 059 revised", { exact: true })).toBeVisible();
    await expectOnlyCommandCenterRowRendered(
      page,
      `agent:${getServerId()}:${seeded.agents[59].id}`,
    );

    await searchCommandCenter(panel, "Search workspace");
    await expect(panel.getByText("Search workspace 039", { exact: true })).toBeVisible();
    await warmCommandCenterRows(page);
    await seeded.client.setWorkspaceTitle(seeded.workspaces[39].id, "Search workspace 039 revised");
    await expect(panel.getByText("Search workspace 039 revised", { exact: true })).toBeVisible();
    await expectOnlyCommandCenterRowRendered(
      page,
      `workspace:${getServerId()}:${seeded.workspaces[39].id}`,
    );

    await searchCommandCenter(panel, "Search agent");
    await warmCommandCenterRows(page);
    await scrollToOldestCommandCenterAgent(panel);
    await expect(panel.getByText("Search agent 000", { exact: true })).toBeVisible();
    await expectCommandCenterAgentWindow(panel, seeded.agents.length);
  } finally {
    await seeded.cleanup();
  }
});
