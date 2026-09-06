import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  expectCommandCenterToRemainAtTheTop,
  expectPrimaryCommandCenterActions,
  expectTightTwoLineResultSpacing,
  expectVisibleKeyboardNavigationNotToScroll,
  expectWorkspaceResultsToBeLimitedUntilSearch,
  observeCommandCenterScroll,
  openCommandCenterWithKeyboard,
} from "../support/helpers/command-center-scroll";
import {
  captureActiveListHighlight,
  navigateToHighlightedListItem,
} from "../support/helpers/list-navigation";
import { seedWorkspace } from "../support/helpers/seed-client";

test.use({
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/145.0 Safari/537.36",
});

test("opening the command center keeps its first result fully visible", async ({ page }) => {
  const seeded = await seedWorkspace({
    repoPrefix: "command-center-scroll-",
    title: "Command Center Scroll 00",
  });

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
    }

    await gotoAppShell(page);
    await observeCommandCenterScroll(page);
    const panel = await openCommandCenterWithKeyboard(page);

    await expectCommandCenterToRemainAtTheTop(page);
    await expectPrimaryCommandCenterActions(panel);
    await expectVisibleKeyboardNavigationNotToScroll(page, panel);
    await expectTightTwoLineResultSpacing(panel, "Command Center Scroll 00");
    await expectWorkspaceResultsToBeLimitedUntilSearch(panel);
  } finally {
    await seeded.cleanup();
  }
});

test("Ctrl+N and Ctrl+P move the command center highlight", async ({ page }) => {
  await gotoAppShell(page);
  const panel = await openCommandCenterWithKeyboard(page);
  const newWorkspace = panel.getByRole("button").filter({ hasText: "New workspace" });
  const history = panel.getByRole("button").filter({ hasText: "History" });
  const activeBackground = await captureActiveListHighlight(newWorkspace, history);

  await navigateToHighlightedListItem(page, "next", history, activeBackground);
  await expect(panel).toBeVisible();

  await navigateToHighlightedListItem(page, "previous", newWorkspace, activeBackground);
  await expect(panel).toBeVisible();
});
