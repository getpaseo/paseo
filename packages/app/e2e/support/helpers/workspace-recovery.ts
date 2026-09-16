import { expect, type Page } from "@playwright/test";
import { openChangesPanel } from "./branch-switcher";

export async function restoreArchivedWorkspace(page: Page): Promise<void> {
  await expect(page.getByText("Workspace archived", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByText("Workspace archived", { exact: true })).toHaveCount(0, {
    timeout: 30_000,
  });
}

export async function restoreWorkspaceFromHistory(
  page: Page,
  serverId: string,
  agentId: string,
): Promise<void> {
  // History rows have no unique accessible name; their stable ID identifies the session.
  await page.getByTestId(`agent-row-${serverId}-${agentId}`).click();
  await restoreArchivedWorkspace(page);
}

export async function expectCommittedFile(page: Page, filename: string): Promise<void> {
  await openChangesPanel(page);
  await expect(page.getByText(filename, { exact: true }).filter({ visible: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByText("No changes to display", { exact: true }).filter({ visible: true }),
  ).toHaveCount(0);
}

export async function expectCommittedFileAfterReload(page: Page, filename: string): Promise<void> {
  await expectCommittedFile(page, filename);
  await page.reload();
  await expectCommittedFile(page, filename);
}
