import { expect, type Page } from "@playwright/test";
import { getStateLabel } from "@/git/pull-request-panel/data";
import { openPullRequestPanel } from "./workspace-tabs";

export async function openPrPane(page: Page): Promise<void> {
  await openPullRequestPanel(page);
}

export async function expectPrPaneTitle(page: Page, title: string): Promise<void> {
  await expect(page.getByTestId("pr-pane-title")).toContainText(title, { timeout: 15_000 });
}

export async function expectPrPaneState(
  page: Page,
  state: "open" | "merged" | "closed" | "draft",
): Promise<void> {
  await expect(page.getByTestId("pr-pane-state")).toHaveText(getStateLabel(state), {
    timeout: 15_000,
  });
}

export async function expectPrPaneChecks(
  page: Page,
  checks: { success: string[]; failure: string[]; pending: string[] },
): Promise<void> {
  const section = page.getByTestId("pr-pane-checks");
  const groups = [
    { status: "failure", label: /failing checks?$/, names: checks.failure },
    { status: "pending", label: /in progress checks?$/, names: checks.pending },
    { status: "success", label: /successful checks?$/, names: checks.success },
  ];

  for (const group of groups) {
    const groupSection = section.getByTestId(`pr-pane-check-group-${group.status}`);
    await expect(groupSection.getByRole("button", { name: group.label })).toBeVisible({
      timeout: 15_000,
    });
    for (const name of group.names) {
      await expect(groupSection.getByText(name, { exact: true })).toHaveCount(1);
    }
  }
}

export async function expectPrPaneActivity(page: Page, bodies: string[]): Promise<void> {
  const activity = page.getByTestId("pr-pane-activity-row");
  for (const body of bodies) {
    await expect(activity.getByText(body, { exact: true })).toBeVisible({ timeout: 15_000 });
  }
}
