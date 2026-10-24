import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { createIdleAgent } from "../support/helpers/archive-tab";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";

const TITLE_MAX_LENGTH = 80;

function normalizedTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

function expectedTooltipTitle(title: string): string {
  const singleLineTitle = normalizedTitle(title);
  return singleLineTitle.length <= TITLE_MAX_LENGTH
    ? singleLineTitle
    : `${singleLineTitle.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

async function openAgent(page: Page, agent: { id: string; workspaceId: string }): Promise<void> {
  await page.goto(buildHostAgentDetailRoute(getServerId(), agent.id, agent.workspaceId));
  await page.waitForURL(
    (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
    { timeout: 60_000 },
  );
  await waitForWorkspaceTabsVisible(page);
}

async function openAgentTabTooltip(page: Page, agentId: string, title: string): Promise<Locator> {
  await page.getByRole("button", { name: normalizedTitle(title), exact: true }).hover();
  const tooltip = page.getByTestId(`workspace-tab-tooltip-agent_${agentId}`);
  await expect(tooltip).toBeVisible({ timeout: 10_000 });
  return tooltip;
}

async function expectTwoRowAgentSummary(
  tooltip: Locator,
  input: { title: string; agentId: string },
): Promise<void> {
  const title = tooltip.getByText(expectedTooltipTitle(input.title), { exact: true });
  const id = tooltip.getByText(input.agentId.slice(0, 7), { exact: true });
  const activity = tooltip.getByText(/^(just now|\d+[mhd] ago|[A-Z][a-z]{2} \d{1,2})$/);

  await expect(title).toBeVisible();
  await expect(id).toBeVisible();
  await expect(tooltip.getByText("·", { exact: true })).toBeVisible();
  await expect(activity).toBeVisible();
  expect((await title.boundingBox())?.y).toBeLessThan((await id.boundingBox())?.y ?? 0);
}

async function renderedOpacity(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    let opacity = 1;
    for (let node: Element | null = element; node; node = node.parentElement) {
      opacity *= Number.parseFloat(getComputedStyle(node).opacity);
    }
    return opacity;
  });
}

test.describe("Workspace agent tab tooltip", () => {
  test("summarizes a multiline agent title above its ID and last activity", async ({ page }) => {
    test.setTimeout(120_000);
    const workspace = await seedWorkspace({ repoPrefix: "workspace-agent-tooltip-" });

    try {
      const title = [
        "Short first line",
        "followed by a much longer continuation that should be joined before the complete title is truncated to a useful tooltip length",
      ].join("\n");
      const agent = await createIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title,
      });

      await openAgent(page, agent);
      const tooltip = await openAgentTabTooltip(page, agent.id, title);

      await expectTwoRowAgentSummary(tooltip, { title, agentId: agent.id });
    } finally {
      await workspace.cleanup();
    }
  });

  test("shows the complete long title in the tab context menu", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 800, height: 1000 });
    const workspace = await seedWorkspace({ repoPrefix: "workspace-tab-full-title-" });

    try {
      const title =
        "检查 Android 平板模式下多个工作区标签的标题显示与选中状态，确保长标题可以完整阅读。".repeat(
          3,
        );
      const agent = await createIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title,
      });
      await openAgent(page, agent);
      const tab = page.getByTestId(`workspace-tab-agent_${agent.id}`);
      await tab.click({ button: "right" });
      const rename = page.getByRole("menuitem", { name: "Rename", exact: true });
      await expect(rename).toBeVisible();
      await expect.poll(() => renderedOpacity(rename)).toBeGreaterThanOrEqual(0.99);
      const screenshot = testInfo.outputPath("tab-context-menu.png");
      await page.screenshot({ path: screenshot });
      await testInfo.attach("tab-context-menu", { path: screenshot, contentType: "image/png" });
      const heading = page.getByTestId(`workspace-tab-title-agent_${agent.id}`);
      await expect(heading).toBeVisible();
      await expect(heading).toHaveText(title);
      const text = heading.locator("[dir=auto]");
      const geometry = await text.evaluate((node) => ({
        height: node.getBoundingClientRect().height,
        fontSize: Number.parseFloat(getComputedStyle(node).fontSize),
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
      }));
      expect(geometry.height).toBeGreaterThan(geometry.fontSize * 2);
      expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight + 1);
      await expect(page.getByRole("menuitem", { name: "Rename", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(heading).not.toBeVisible();
      await expect(tab).toHaveAttribute("aria-selected", "true");
    } finally {
      await workspace.cleanup();
    }
  });
});
