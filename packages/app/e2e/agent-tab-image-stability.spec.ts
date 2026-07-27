import type { Page } from "@playwright/test";
import { expect, test as base } from "./fixtures";
import {
  clickSessionRow,
  openSessions,
  openWorkspaceWithAgents,
  type ArchiveTabAgent,
} from "./helpers/archive-tab";
import { seedWorkspace, type SeedDaemonClient, type SeededWorkspace } from "./helpers/seed-client";

const IMAGE_ALT = "Synthetic image";
const IMAGE_PREVIEW_ERROR = "Unable to load image preview.";
const IMAGE_PROMPT = "Emit 4096 byte image agent stream update";

const test = base.extend<{ imageWorkspace: SeededWorkspace }>({
  imageWorkspace: async ({ page: _page }, provide) => {
    const workspace = await seedWorkspace({ repoPrefix: "agent-tab-image-stability-" });
    await provide(workspace);
    await workspace.cleanup();
  },
});

async function createMockAgent(
  client: SeedDaemonClient,
  input: { cwd: string; workspaceId: string; title: string },
): Promise<ArchiveTabAgent> {
  const agent = await client.createAgent({
    provider: "mock",
    model: "ten-second-stream",
    modeId: "load-test",
    cwd: input.cwd,
    workspaceId: input.workspaceId,
    title: input.title,
  });
  await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "idle", 30_000);
  return { id: agent.id, ...input };
}

async function observeImagePreviewInstability(page: Page, imageAgentId: string): Promise<void> {
  await page.evaluate(
    ({ alt, errorText, tabTestId }) => {
      const root = document.documentElement;
      root.dataset.agentTabImageErrorFlash = "false";
      root.dataset.agentTabImageMissingFlash = "false";
      const isVisible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const inspect = () => {
        const errorVisible = Array.from(document.querySelectorAll("*")).some((element) => {
          if (element.children.length > 0 || element.textContent?.trim() !== errorText) {
            return false;
          }
          return isVisible(element);
        });
        if (errorVisible) {
          root.dataset.agentTabImageErrorFlash = "true";
        }
        const imageTab = document.querySelector(`[data-testid="${tabTestId}"]`);
        if (imageTab?.getAttribute("aria-selected") !== "true") {
          return;
        }
        const imageVisible = Array.from(document.querySelectorAll('[role="img"]')).some(
          (element) => element.getAttribute("aria-label") === alt && isVisible(element),
        );
        if (!imageVisible) {
          root.dataset.agentTabImageMissingFlash = "true";
        }
      };
      const observer = new MutationObserver(inspect);
      observer.observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true,
        characterData: true,
      });
      window.setTimeout(() => observer.disconnect(), 5_000);
    },
    {
      alt: IMAGE_ALT,
      errorText: IMAGE_PREVIEW_ERROR,
      tabTestId: `workspace-tab-agent_${imageAgentId}`,
    },
  );
}

async function expectNoObservedImagePreviewInstability(page: Page): Promise<void> {
  await page.waitForTimeout(250);
  expect(await page.locator("html").getAttribute("data-agent-tab-image-error-flash")).toBe("false");
  expect(await page.locator("html").getAttribute("data-agent-tab-image-missing-flash")).toBe(
    "false",
  );
}

async function switchToSettledAgentTab(page: Page, agent: ArchiveTabAgent): Promise<void> {
  const tab = page.getByRole("button", { name: agent.title, exact: true });
  await tab.click();
  await expect(page).toHaveTitle(agent.title);
  await expect(page.locator('[data-testid="agent-chat-scroll"]:visible').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

test("switching between settled agent tabs keeps the image timeline valid", async ({
  imageWorkspace: workspace,
  page,
}) => {
  test.setTimeout(120_000);
  const imageAgent = await createMockAgent(workspace.client, {
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: `Image timeline ${Date.now()}`,
  });
  const otherAgent = await createMockAgent(workspace.client, {
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: `Other timeline ${Date.now()}`,
  });
  await workspace.client.sendAgentMessage(imageAgent.id, IMAGE_PROMPT);
  await workspace.client.waitForFinish(imageAgent.id, 15_000);
  await openWorkspaceWithAgents(page, [otherAgent, imageAgent]);
  await expect(page.getByRole("img", { name: IMAGE_ALT })).toBeVisible({ timeout: 30_000 });

  await switchToSettledAgentTab(page, otherAgent);
  await observeImagePreviewInstability(page, imageAgent.id);
  await switchToSettledAgentTab(page, imageAgent);

  await expect(page.getByRole("img", { name: IMAGE_ALT })).toBeVisible({ timeout: 30_000 });
  await expectNoObservedImagePreviewInstability(page);
});

test("reopening an image timeline after editing another draft keeps its image available", async ({
  imageWorkspace: workspace,
  page,
}) => {
  test.setTimeout(120_000);
  const imageAgent = await createMockAgent(workspace.client, {
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: `Image cleanup ${Date.now()}`,
  });
  const otherAgent = await createMockAgent(workspace.client, {
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: `Draft cleanup ${Date.now()}`,
  });
  await workspace.client.sendAgentMessage(imageAgent.id, IMAGE_PROMPT);
  await workspace.client.waitForFinish(imageAgent.id, 15_000);
  await openWorkspaceWithAgents(page, [otherAgent, imageAgent]);
  await expect(page.getByRole("img", { name: IMAGE_ALT })).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: otherAgent.title, exact: true }).click();
  await page
    .getByRole("textbox", { name: "Message agent..." })
    .fill("Keep this draft while I check history");
  await openSessions(page);
  await observeImagePreviewInstability(page, imageAgent.id);
  await clickSessionRow(page, imageAgent.title);

  await expect(page.getByRole("img", { name: IMAGE_ALT })).toBeVisible({ timeout: 30_000 });
  await expectNoObservedImagePreviewInstability(page);
});
