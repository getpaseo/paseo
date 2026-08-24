import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";

test("a workspace with an existing agent never presents New during startup", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "new-tab-startup-agent-" });
  const agent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: "Existing startup agent",
    modeId: "load-test",
    model: "ten-second-stream",
    initialPrompt: "ready",
  });

  try {
    await page.addInitScript(() => {
      Reflect.set(globalThis, "__paseoSawVisibleNewTab", false);
      function recordVisibleNewTab() {
        const panel = document.querySelector('[data-testid="workspace-new-tab-panel"]');
        if (panel?.getClientRects().length) {
          Reflect.set(globalThis, "__paseoSawVisibleNewTab", true);
        }
      }
      window.addEventListener("DOMContentLoaded", () => {
        new MutationObserver(recordVisibleNewTab).observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
        recordVisibleNewTab();
      });
    });

    await gotoWorkspace(page, workspace.workspaceId);
    await expect(
      page.getByTestId(`workspace-tab-agent_${agent.id}`).filter({ visible: true }),
    ).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
    await expect(page.getByTestId("workspace-new-tab-panel").filter({ visible: true })).toHaveCount(
      0,
    );
    expect(await page.evaluate(() => Reflect.get(globalThis, "__paseoSawVisibleNewTab"))).toBe(
      false,
    );
  } finally {
    await workspace.cleanup();
  }
});
