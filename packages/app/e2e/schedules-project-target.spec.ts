import { expect, test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { getServerId } from "./helpers/server-id";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";
import { waitForSidebarHydration } from "./helpers/workspace-ui";

interface ScheduleListItem {
  id: string;
  name: string | null;
  target: { type: string; config?: { cwd?: string } };
}

interface ScheduleSeedClient {
  scheduleList(): Promise<{ schedules: ScheduleListItem[]; error: string | null }>;
  scheduleDelete(input: { id: string }): Promise<{ error: string | null }>;
}

async function deleteScheduleByName(workspace: SeededWorkspace, name: string): Promise<void> {
  const client = workspace.client as unknown as ScheduleSeedClient;
  const list = await client.scheduleList();
  const schedule = list.schedules.find((candidate) => candidate.name === name);
  if (schedule) {
    await client.scheduleDelete({ id: schedule.id }).catch(() => undefined);
  }
}

async function expectScheduleCreatedForProject(input: {
  workspace: SeededWorkspace;
  name: string;
}): Promise<void> {
  const client = input.workspace.client as unknown as ScheduleSeedClient;
  const list = await client.scheduleList();
  const schedule = list.schedules.find((candidate) => candidate.name === input.name);
  expect(schedule).toEqual(
    expect.objectContaining({
      name: input.name,
      target: expect.objectContaining({
        type: "new-agent",
        config: expect.objectContaining({
          cwd: input.workspace.repoPath,
        }),
      }),
    }),
  );
}

test.describe("Schedules project target", () => {
  test("creates a schedule from a project picker instead of a raw CWD selector", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "schedule-project-target-" });
    const scheduleName = `Project schedule ${Date.now()}`;

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await page.getByTestId("sidebar-schedules").click();
      await expect(page).toHaveURL(/\/schedules$/);
      await expect(page).not.toHaveURL(/\/h\//);
      await expect(page.getByTestId(`schedules-section-${getServerId()}`)).toBeVisible();

      await page.getByTestId("schedules-new").click();
      await expect(page.getByTestId("schedule-form-sheet")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("schedule-cwd-trigger")).toHaveCount(0);

      await page.getByTestId("schedule-project-trigger").click();
      await page.getByTestId(`schedule-project-option-${workspace.projectId}`).click();
      await expect(page.getByTestId("schedule-project-trigger")).toContainText(
        workspace.projectDisplayName,
      );

      await page.getByTestId("schedule-name-input").fill(scheduleName);
      await page.getByTestId("schedule-prompt-input").fill("Summarize the project status.");
      await page.getByText("Cron", { exact: true }).click();
      await page.getByTestId("schedule-form-submit").click();

      await expect(page.getByTestId("schedule-form-sheet")).toHaveCount(0, { timeout: 30_000 });
      await expectScheduleCreatedForProject({ workspace, name: scheduleName });
    } finally {
      await deleteScheduleByName(workspace, scheduleName);
      await workspace.cleanup();
    }
  });
});
