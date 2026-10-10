import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openSubagentsTrack, seedParentWithSubagent } from "../support/helpers/subagents";

const SETTINGS_KEY = "@paseo:app-settings";

async function openParentInRightPane(page: Page, parentId: string, workspaceId: string) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openAgentRoute(page, { workspaceId, agentId: parentId });
  await expect(page.getByTestId(`workspace-tab-agent_${parentId}`)).toBeVisible();
  await page.getByTestId("workspace-pane-main").getByTestId("workspace-new-tab-button").click();
  await page.getByTestId("workspace-new-tab-menu-agent").click();
  await page.getByTestId(`workspace-tab-agent_${parentId}`).click();
  await runWorkspaceActionFromCommandCenter(page, "Split pane right");
  await page
    .getByTestId("workspace-pane-main")
    .getByTestId(`workspace-tab-agent_${parentId}`)
    .click();
  await page.keyboard.press("Meta+Alt+Shift+ArrowRight");

  const left = page.getByTestId("workspace-pane-main");
  const right = page
    .locator('[data-testid^="workspace-pane-"]')
    .filter({ has: page.getByTestId(`workspace-tab-agent_${parentId}`) });
  await expect(left).toBeVisible();
  await expect(right).toBeVisible();
  await expect(right).not.toHaveAttribute("data-testid", "workspace-pane-main");
  await left.locator('[data-testid^="workspace-tab-draft_"]').click();
  return { left, right };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  });
});

test("a subagent opened from a right-pane parent stays with its parent when left has focus", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "subagent-origin-pane-" });
  try {
    const pair = await seedParentWithSubagent(workspace, {
      parentTitle: "Right parent",
      childTitle: "Child agent",
    });
    const { left, right } = await openParentInRightPane(page, pair.parent.id, pair.workspaceId);
    await openSubagentsTrack(page);
    await page.getByTestId(`subagents-track-row-${pair.child.id}`).click();

    await expect(right.getByTestId(`workspace-tab-agent_${pair.child.id}`)).toBeVisible();
    await expect(left.getByTestId(`workspace-tab-agent_${pair.child.id}`)).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});

test("the side preference opens a right-pane parent's subagent in the side pane", async ({
  page,
}) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({ openInSidePane: { subagents: true } }));
  }, SETTINGS_KEY);
  const workspace = await seedWorkspace({ repoPrefix: "subagent-side-preference-" });
  try {
    const pair = await seedParentWithSubagent(workspace, {
      parentTitle: "Right parent",
      childTitle: "Child agent",
    });
    const { left, right } = await openParentInRightPane(page, pair.parent.id, pair.workspaceId);
    await openSubagentsTrack(page);
    await page.getByTestId(`subagents-track-row-${pair.child.id}`).click();

    const childPane = page
      .locator('[data-testid^="workspace-pane-"]')
      .filter({ has: page.getByTestId(`workspace-tab-agent_${pair.child.id}`) });
    await expect(childPane).toBeVisible();
    expect(await childPane.getAttribute("data-testid")).not.toBe(
      await right.getAttribute("data-testid"),
    );
    await expect(childPane).not.toHaveAttribute("data-testid", "workspace-pane-main");
    await expect(left.getByTestId(`workspace-tab-agent_${pair.child.id}`)).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});

test("opening an already-tabbed subagent reveals its left tab without a duplicate", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "subagent-existing-tab-" });
  try {
    const pair = await seedParentWithSubagent(workspace, {
      parentTitle: "Right parent",
      childTitle: "Child agent",
    });
    const { left, right } = await openParentInRightPane(page, pair.parent.id, pair.workspaceId);
    await openSubagentsTrack(page);
    await page.getByTestId(`subagents-track-row-${pair.child.id}`).click();
    await expect(right.getByTestId(`workspace-tab-agent_${pair.child.id}`)).toBeVisible();
    await page.keyboard.press("Meta+Alt+Shift+ArrowLeft");
    await expect(left.getByTestId(`workspace-tab-agent_${pair.child.id}`)).toBeVisible();
    await right.getByTestId(`workspace-tab-agent_${pair.parent.id}`).click();
    await openSubagentsTrack(page);
    await page.getByTestId(`subagents-track-row-${pair.child.id}`).click();

    await expect(left.getByTestId(`workspace-tab-agent_${pair.child.id}`)).toBeVisible();
    await expect(right.getByTestId(`workspace-tab-agent_${pair.child.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`workspace-tab-agent_${pair.child.id}`)).toHaveCount(1);
  } finally {
    await workspace.cleanup();
  }
});

test("a preferred chat file link still opens beside its right-pane agent", async ({ page }) => {
  const target = "linked.ts:3";
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "chat-file-origin-pane-",
    title: "File link parent",
    initialPrompt: [
      "Generate a title and a git branch name for a coding agent from the user prompt and attachments.",
      "Return JSON only with fields 'title' and 'branch'.",
      "",
      "<user-prompt>",
      `Open \`${target}\` now`,
      "</user-prompt>",
    ].join("\n"),
  });
  try {
    await writeFile(path.join(workspace.cwd, "linked.ts"), "one\ntwo\nthree\n", "utf8");
    const { left, right } = await openParentInRightPane(
      page,
      workspace.agentId,
      workspace.workspaceId,
    );
    const fileLink = right.getByText(target, { exact: true });
    await expect(fileLink).toBeVisible({ timeout: 15_000 });
    await fileLink.click();

    await expect(right.getByTestId("workspace-tab-file_linked.ts")).toBeVisible();
    await expect(left.getByTestId("workspace-tab-file_linked.ts")).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});
