import { expect, type Page } from "@playwright/test";

export async function openCompletedTaskList(page: Page, count: number): Promise<void> {
  const taskButton = page.getByRole("button", { name: `${count}/${count} tasks` });
  await expect(taskButton).toBeVisible({ timeout: 60_000 });
  await taskButton.click();
}

export async function expectTaskListEntries(page: Page, entries: readonly string[]): Promise<void> {
  for (const entry of entries) {
    await expect(page.getByLabel(entry, { exact: true })).toBeVisible();
  }
}

export async function expectCompletedTaskActivity(
  page: Page,
  entries: readonly string[],
): Promise<void> {
  for (const entry of entries) {
    await expect(
      page.getByRole("button", { name: `Completed ${entry}`, exact: true }),
    ).toBeVisible();
  }
}
