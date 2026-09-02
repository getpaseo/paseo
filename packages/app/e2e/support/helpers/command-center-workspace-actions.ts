import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { openCommandCenter } from "./command-center";
import { expectAppRoute } from "./route-assertions";
import type { SeededWorkspace } from "./seed-client";
import { getServerId } from "./server-id";
import { expectTerminalTabOpen } from "./workspace-tabs";

function action(panel: Locator, title: string): Locator {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return panel.getByRole("button", { name: new RegExp(`^${escapedTitle}(?:\\s|$)`) });
}

export async function makeWorkspacePrimaryGitActionCommit(seeded: SeededWorkspace): Promise<void> {
  writeFileSync(path.join(seeded.repoPath, "command-center-dirty.txt"), "dirty\n");
  const refreshed = await seeded.client.checkoutRefresh(seeded.repoPath);
  if (!refreshed.success) {
    throw new Error(`Failed to refresh checkout: ${JSON.stringify(refreshed.error)}`);
  }
}

export async function openWorkspaceFromCommandCenter(
  page: Page,
  seeded: SeededWorkspace,
  title: string,
): Promise<void> {
  const panel = await openCommandCenter(page);
  await panel.getByTestId("command-center-input").fill(title);
  await page.keyboard.press("Enter");
  await expectAppRoute(page, buildHostWorkspaceRoute(getServerId(), seeded.workspaceId), {
    timeout: 30_000,
  });
}

export async function expectDefaultWorkspaceActions(panel: Locator): Promise<void> {
  await expect(panel.getByText("Workspace actions", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(action(panel, "New agent")).toBeVisible();
  await expect(action(panel, "Commit")).toBeVisible();
  await expect(action(panel, "Push")).toHaveCount(0);
  await expect(action(panel, "New terminal")).toHaveCount(0);
  await expect(action(panel, "Split pane right")).toHaveCount(0);
  await expect(action(panel, "Home")).toHaveCount(0);
  await expect(action(panel, "Add project")).toHaveCount(0);
}

export async function expectWorkspaceActionsAvailableThroughSearch(panel: Locator): Promise<void> {
  const input = panel.getByTestId("command-center-input");
  await input.fill("push");
  await expect(action(panel, "Push")).toBeVisible();

  await input.fill("home");
  await expect(action(panel, "Home")).toBeVisible();

  await input.fill("git");
  await expect.poll(() => panel.getByRole("button").count()).toBeGreaterThan(1);
}

export async function createTerminalFromCommandCenter(page: Page, panel: Locator): Promise<void> {
  await panel.getByTestId("command-center-input").fill("terminal");
  await page.keyboard.press("Enter");
  await expectTerminalTabOpen(page);
}

export async function runWorkspaceActionFromCommandCenter(
  page: Page,
  title: string,
): Promise<void> {
  const panel = await openCommandCenter(page);
  await panel.getByTestId("command-center-input").fill(title);
  await action(panel, title).click();
}
