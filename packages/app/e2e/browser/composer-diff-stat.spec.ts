import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { ensureExplorerSidebar, openFilesPanel } from "../support/helpers/workspace-tabs";

const APP_SETTINGS_KEY = "@paseo:app-settings";

function visibleMainPane(page: Page) {
  return page.getByTestId("workspace-pane-main").filter({ visible: true });
}

function composerChangesPill(page: Page) {
  return page.getByTestId("composer-diff-stat-pill");
}

async function revealComposerChangesInExplorer(page: Page) {
  await composerChangesPill(page).click();

  const explorer = await ensureExplorerSidebar(page);
  await expect(explorer.getByTestId("changes-tree-panel")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("workspace-tab-working_diff")).toHaveCount(0);
}

async function openComposerDiff(page: Page) {
  await composerChangesPill(page).click();
}

async function seedChangedAgent(repoPrefix: string) {
  const workspace = await seedMockAgentWorkspace({
    repoPrefix,
    title: "Composer diff stat",
    repo: {
      withRemote: true,
      // Exclude the local remote before the daemon starts observing this checkout.
      files: [{ path: ".gitignore", content: "/remote.git/\n" }],
    },
  });
  try {
    await writeFile(
      path.join(workspace.cwd, "README.md"),
      "# Temp Repo\nexport const one = 1;\nexport const two = 2;\n",
    );
    await workspace.client.checkoutRefresh(workspace.cwd);
    await expect
      .poll(async () => {
        const workspaces = await workspace.client.fetchWorkspaces();
        return (
          workspaces.entries.find((entry) => entry.id === workspace.workspaceId)?.diffStat ?? null
        );
      })
      .toEqual({ additions: 2, deletions: 0 });
    return workspace;
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}

test("composer diff stat reveals Changes, then opens the diff in the configured side pane", async ({
  page,
}) => {
  await page.addInitScript((settingsKey) => {
    localStorage.setItem(settingsKey, JSON.stringify({ openInSidePane: { diffs: true } }));
  }, APP_SETTINGS_KEY);
  const workspace = await seedChangedAgent("composer-diff-stat-side-");

  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openAgentRoute(page, {
      workspaceId: workspace.workspaceId,
      agentId: workspace.agentId,
    });

    const pill = composerChangesPill(page);
    await expect(pill).toBeVisible({ timeout: 30_000 });
    await expect(pill).toContainText("+2");
    await expect(pill).toContainText("-0");
    await revealComposerChangesInExplorer(page);
    await openComposerDiff(page);

    const sidePane = page
      .locator('[data-testid^="workspace-pane-"]')
      .filter({ visible: true })
      .filter({ has: page.getByTestId("working-diff-panel") });
    await expect(sidePane.getByTestId("workspace-tab-working_diff")).toBeVisible({
      timeout: 30_000,
    });
    await expect(sidePane.getByTestId("working-diff-panel")).toBeVisible({ timeout: 30_000 });
    await expect(visibleMainPane(page).getByTestId("working-diff-panel")).toHaveCount(0);

    await test.step("Explorer navigation does not replace the side pane", async () => {
      await openFilesPanel(page);
      await expect(page.getByTestId("workspace-explorer-sidebar")).toContainText("Files");

      await pill.click();
      await expect(sidePane.getByTestId("working-diff-panel")).toBeVisible();
      await expect(page.getByTestId("workspace-tab-working_diff")).toHaveCount(1);
    });
  } finally {
    await workspace.cleanup();
  }
});

test("composer diff stat opens the compact explorer instead of a Changes tab", async ({ page }) => {
  const workspace = await seedChangedAgent("composer-diff-stat-compact-");

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentRoute(page, {
      workspaceId: workspace.workspaceId,
      agentId: workspace.agentId,
    });

    const closeExplorer = page
      .getByTestId("explorer-header")
      .getByRole("button", { name: "Close Explorer sidebar" });
    await expect(closeExplorer).not.toBeInViewport();

    await page.getByTestId("composer-diff-stat-pill").click();

    await expect(closeExplorer).toBeInViewport({ timeout: 30_000 });
    await expect(page.getByTestId("changes-header").filter({ visible: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("workspace-tab-working_diff")).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});

test("composer diff stat reveals Changes, then opens the diff in the focused pane by default", async ({
  page,
}) => {
  const workspace = await seedChangedAgent("composer-diff-stat-tab-");

  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openAgentRoute(page, {
      workspaceId: workspace.workspaceId,
      agentId: workspace.agentId,
    });

    await revealComposerChangesInExplorer(page);
    await openComposerDiff(page);

    const mainPane = visibleMainPane(page);
    await expect(mainPane.getByTestId("workspace-tab-working_diff")).toBeVisible({
      timeout: 30_000,
    });
    await expect(mainPane.getByTestId("working-diff-panel")).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator('[data-testid^="workspace-pane-"]').filter({ visible: true }),
    ).toHaveCount(1);
  } finally {
    await workspace.cleanup();
  }
});

async function tapFirstAddedDiffLine(page: Page) {
  const body = page.getByTestId("working-diff-panel").getByTestId("diff-file-0-body");
  const bounds = await body.boundingBox();
  if (!bounds) throw new Error("Expanded diff body has no bounds");
  const fontSize = await page
    .getByTestId("working-diff-panel")
    .getByTestId("git-diff-canvas")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  await page.touchscreen.tap(bounds.x + 120, bounds.y + Math.round(fontSize * 1.5) * 2.5);
}

async function openReviewDiff(page: Page, workspace: Awaited<ReturnType<typeof seedChangedAgent>>) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: workspace.agentId });
  await revealComposerChangesInExplorer(page);
  await openComposerDiff(page);
  await expect(page.getByTestId("diff-file-0-body")).toBeVisible();
}

async function saveReviewComment(page: Page, body: string) {
  await page.getByRole("textbox", { name: "Review comment" }).fill(body);
  await page.getByRole("button", { name: "Save review comment", exact: true }).click();
  await expect(page.getByRole("button", { name: "Bottom sheet backdrop" })).toHaveCount(0);
}

async function cancelReviewComment(page: Page) {
  await page.getByRole("button", { name: "Cancel review comment", exact: true }).click();
  await expect(page.getByRole("button", { name: "Bottom sheet backdrop" })).toHaveCount(0);
}

test.describe("review comments", () => {
  test.use({ hasTouch: true });

  test("compact review comments open a sheet and preserve saved comments through save, edit, cancel and reload", async ({
    page,
  }) => {
    const workspace = await seedChangedAgent("compact-review-comment-");
    try {
      await openReviewDiff(page, workspace);
      await page.setViewportSize({ width: 390, height: 844 });
      await tapFirstAddedDiffLine(page);
      const sheet = page.getByTestId("review-comment-sheet");
      await expect(sheet).toBeVisible();
      await expect(page.getByText("README.md · +2", { exact: true })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Review comment" })).toBeInViewport({
        ratio: 1,
      });
      await expect(
        page.getByRole("button", { name: "Save review comment", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await expect(
        page.getByRole("button", { name: "Cancel review comment", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await expect(
        page.getByRole("button", { name: "Save review comment", exact: true }),
      ).toHaveText("Save");
      await page.screenshot({ path: "/tmp/phase1-comment-sheet.png" });
      await expect(page.getByTestId("inline-review-editor")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Save review comment", exact: true }),
      ).toBeDisabled();
      await saveReviewComment(page, "  Please simplify this.  ");
      await expect(sheet).toHaveCount(0);
      await expect(
        page.getByTestId("working-diff-panel").getByText("Please simplify this.", { exact: true }),
      ).toBeVisible();

      await page
        .getByTestId("working-diff-panel")
        .getByRole("button", { name: "Edit review comment", exact: true })
        .click();
      await expect(page.getByRole("textbox", { name: "Review comment" })).toHaveValue(
        "Please simplify this.",
      );
      await expect(
        page.getByTestId("working-diff-panel").getByText("Please simplify this.", { exact: true }),
      ).toBeVisible();
      await page.getByRole("textbox", { name: "Review comment" }).fill("Discard this edit");
      await cancelReviewComment(page);
      await expect(
        page.getByTestId("working-diff-panel").getByText("Please simplify this.", { exact: true }),
      ).toBeVisible();
      await page
        .getByTestId("working-diff-panel")
        .getByRole("button", { name: "Edit review comment", exact: true })
        .click();
      await saveReviewComment(page, "Updated comment");
      await expect(
        page.getByTestId("working-diff-panel").getByText("Updated comment", { exact: true }),
      ).toBeVisible();
      await tapFirstAddedDiffLine(page);
      await page.getByRole("textbox", { name: "Review comment" }).fill("Discard new comment");
      await cancelReviewComment(page);
      await expect(
        page.getByTestId("working-diff-panel").getByText("Discard new comment", { exact: true }),
      ).toHaveCount(0);
      await page.reload();
      await expect(
        page.getByTestId("working-diff-panel").getByText("Updated comment", { exact: true }),
      ).toBeVisible({
        timeout: 30_000,
      });
      await page.screenshot({ path: "/tmp/phase1-compact-comment.png" });
    } finally {
      await workspace.cleanup();
    }
  });

  test("wide review comments retain inline editing", async ({ page }) => {
    const workspace = await seedChangedAgent("wide-review-comment-");
    try {
      await openReviewDiff(page, workspace);
      await tapFirstAddedDiffLine(page);
      await expect(page.getByTestId("inline-review-editor")).toBeVisible();
      await expect(page.getByTestId("review-comment-sheet")).toHaveCount(0);
      await saveReviewComment(page, "Wide comment");
      await expect(
        page.getByTestId("working-diff-panel").getByText("Wide comment", { exact: true }),
      ).toBeVisible();
      await page
        .getByTestId("working-diff-panel")
        .getByRole("button", { name: "Edit review comment", exact: true })
        .click();
      await expect(page.getByTestId("inline-review-editor")).toBeVisible();
      await cancelReviewComment(page);
      await expect(
        page.getByTestId("working-diff-panel").getByText("Wide comment", { exact: true }),
      ).toBeVisible();
      await sendReviewThroughComposer(page, workspace.agentId);
      await page.getByTestId("workspace-tab-working_diff").click();
      await expect(
        page.getByTestId("working-diff-panel").getByText("Wide comment", { exact: true }),
      ).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });
});

async function sendReviewThroughComposer(page: Page, agentId: string) {
  await page.getByTestId(`workspace-tab-agent_${agentId}`).click();
  await expect(page.getByTestId("composer-review-attachment-pill")).toBeVisible();
  await page.getByRole("textbox", { name: "Message agent..." }).fill("Address this review");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Address this review", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("composer-review-attachment-pill")).toHaveCount(0);
}
