import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  delayBrowserAgentCreatedStatus,
  openNewWorkspaceComposer,
  submitNewWorkspacePrompt,
} from "../support/helpers/new-workspace";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

// The creation response carries the descriptor captured when the workspace was provisioned. With an
// initial agent it is sent only after the agent starts, so a pin made in between (by a plugin's
// workspace.created hook, another client, or the CLI) reaches the app first as a live update. The
// late response must not put the old, unpinned row back.

function pinnedRowTestId(workspaceId: string): string {
  return `sidebar-workspace-row-${getServerId()}:${workspaceId}`;
}

async function findCreatedWorkspaceId(seeded: SeededWorkspace): Promise<string> {
  let createdId: string | undefined;
  await expect
    .poll(
      async () => {
        const { entries } = await seeded.client.fetchWorkspaces({
          filter: { projectId: seeded.projectId },
        });
        createdId = entries.find((entry) => entry.id !== seeded.workspaceId)?.id;
        return createdId;
      },
      { timeout: 30_000 },
    )
    .toBeTruthy();
  return createdId!;
}

// Samples every frame, so a row that leaves Pinned and comes back on a later update still counts.
async function watchPinnedRow(page: Page, testId: string): Promise<() => Promise<number>> {
  await page.evaluate((rowTestId) => {
    const state = { missingFrames: 0, stopped: false };
    (window as unknown as { __pinnedRowWatch: typeof state }).__pinnedRowWatch = state;
    const sample = () => {
      if (state.stopped) return;
      const section = document.querySelector('[data-testid="sidebar-pinned-section"]');
      if (!section?.querySelector(`[data-testid="${rowTestId}"]`)) state.missingFrames += 1;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, testId);
  return () =>
    page.evaluate(() => {
      const state = (
        window as unknown as { __pinnedRowWatch: { missingFrames: number; stopped: boolean } }
      ).__pinnedRowWatch;
      state.stopped = true;
      return state.missingFrames;
    });
}

test.describe("New workspace live pin", () => {
  test("keeps a pin made before the creation response arrives", async ({ page }) => {
    test.setTimeout(120_000);
    const creation = await delayBrowserAgentCreatedStatus(page);
    const seeded = await seedWorkspace({ repoPrefix: "new-workspace-live-pin-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, seeded);
      await submitNewWorkspacePrompt(page, "Pin me while I start");

      await creation.waitForCreateRequest();
      // The response is held here, carrying the descriptor from before the pin.
      await creation.waitForDelayedCreatedStatus();
      const workspaceId = await findCreatedWorkspaceId(seeded);
      const rowTestId = pinnedRowTestId(workspaceId);

      await seeded.client.setWorkspacePinned(workspaceId, true);
      const pinnedRow = page.getByTestId("sidebar-pinned-section").getByTestId(rowTestId);
      await expect(pinnedRow).toBeVisible({ timeout: 10_000 });

      const stopWatching = await watchPinnedRow(page, rowTestId);
      creation.release();
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
      await expect(page.getByRole("textbox", { name: "Message agent..." })).toBeEditable({
        timeout: 30_000,
      });
      // Leave time for the released response to be merged and rendered.
      await page.waitForTimeout(1_000);

      expect(await stopWatching()).toBe(0);
      await expect(pinnedRow).toBeVisible();
    } finally {
      creation.release();
      await seeded.cleanup();
    }
  });
});
