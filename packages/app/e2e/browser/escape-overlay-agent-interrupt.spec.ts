import { test, expect, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

function stopButton(page: Page) {
  return page.getByRole("button", { name: /stop|cancel/i }).first();
}

async function expectAgentStillRunning(page: Page) {
  await expect(stopButton(page)).toBeVisible({ timeout: 10_000 });
}

// Escape belongs to the topmost overlay. The global shortcut dispatcher and the
// overlay key handling are both capture-phase window listeners, and the dispatcher
// registers first (at app mount) — so before the `overlay: false` gate on the
// `agent-interrupt` binding, closing any overlay with Escape also stopped the
// running agent. See #1705.
//
// This drives the exact reported path through the real app: sidebar → workspace
// ⋯ menu → Rename workspace → Escape, against a genuinely streaming agent. The
// final step is the positive control: with nothing open, Escape must still
// interrupt, so a gate that over-suppresses cannot pass this test either.
test("Escape closes sidebar overlays without interrupting the running agent", async ({ page }) => {
  test.setTimeout(120_000);
  const serverId = getServerId();
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "escape-overlay-interrupt-",
    title: "Escape overlay interrupt",
    // A minute of headroom: the overlay interactions below must happen while the
    // turn is unambiguously still streaming.
    model: "one-minute-stream",
  });

  try {
    await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
    await waitForSidebarHydration(page);
    await agent.client.sendAgentMessage(agent.agentId, "Stream while overlays open and close.");
    await expect(stopButton(page)).toBeVisible({ timeout: 30_000 });

    const row = page.getByTestId(`sidebar-workspace-row-${serverId}:${agent.workspaceId}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    const kebab = page.getByTestId(`sidebar-workspace-kebab-${serverId}:${agent.workspaceId}`);
    const renameItem = page.getByTestId(
      `sidebar-workspace-menu-rename-${serverId}:${agent.workspaceId}`,
    );
    const renameInput = page.getByTestId(
      `sidebar-workspace-rename-modal-${serverId}:${agent.workspaceId}-input`,
    );

    await test.step("Escape closes the ⋯ menu and the agent keeps streaming", async () => {
      await row.hover();
      await kebab.click();
      await expect(renameItem).toBeVisible({ timeout: 10_000 });

      await page.keyboard.press("Escape");
      await expect(renameItem).toBeHidden({ timeout: 10_000 });
      await expectAgentStillRunning(page);
    });

    await test.step("Escape cancels the rename dialog and the agent keeps streaming", async () => {
      await row.hover();
      await kebab.click();
      await expect(renameItem).toBeVisible({ timeout: 10_000 });
      await renameItem.click();
      await expect(renameInput).toBeVisible({ timeout: 10_000 });

      await page.keyboard.press("Escape");
      await expect(renameInput).toHaveCount(0, { timeout: 10_000 });
      await expectAgentStillRunning(page);
    });

    await test.step("Escape with no overlay open still interrupts the agent", async () => {
      await page.keyboard.press("Escape");
      await expect(stopButton(page)).toHaveCount(0, { timeout: 30_000 });
    });
  } finally {
    await agent.cleanup();
  }
});
