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

async function observeImagePreviewErrors(page: Page): Promise<void> {
  await page.evaluate((errorText) => {
    const root = document.documentElement;
    root.dataset.agentTabImageErrorFlash = "false";
    const inspect = () => {
      const errorVisible = Array.from(document.querySelectorAll("*")).some((element) => {
        if (element.children.length > 0 || element.textContent?.trim() !== errorText) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (errorVisible) {
        root.dataset.agentTabImageErrorFlash = "true";
      }
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.setTimeout(() => observer.disconnect(), 2_000);
  }, IMAGE_PREVIEW_ERROR);
}

async function expectNoObservedImagePreviewError(page: Page): Promise<void> {
  await page.waitForTimeout(250);
  expect(await page.locator("html").getAttribute("data-agent-tab-image-error-flash")).toBe("false");
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

  await page.getByRole("button", { name: otherAgent.title, exact: true }).click();
  await observeImagePreviewErrors(page);
  await page.getByRole("button", { name: imageAgent.title, exact: true }).click();

  await expect(page.getByRole("img", { name: IMAGE_ALT })).toHaveCount(1, { timeout: 30_000 });
  await expectNoObservedImagePreviewError(page);
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
  await observeImagePreviewErrors(page);
  await clickSessionRow(page, imageAgent.title);

  await expect(page.getByRole("img", { name: IMAGE_ALT })).toBeVisible({ timeout: 30_000 });
  await expectNoObservedImagePreviewError(page);
});
