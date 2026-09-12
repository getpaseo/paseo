import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  addScheduleHostAndReload,
  createScheduleHost,
  SECONDARY_MODEL_ID,
  SECONDARY_MODEL_LABEL,
} from "../support/helpers/schedule-host";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { expectSettled, expectStableHeight } from "../support/helpers/settled";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { buildSchedulesRoute } from "../../src/utils/host-routes";

interface ScheduleSeedClient {
  scheduleCreate(input: {
    prompt: string;
    name?: string;
    cadence: { type: "cron"; expression: string };
    target: {
      type: "new-agent";
      config: {
        provider: "mock";
        cwd: string;
        model: string;
        modeId: string;
        title: string;
      };
    };
    runOnCreate: boolean;
  }): Promise<{ schedule: { id: string } | null; error: string | null }>;
  scheduleDelete(input: { id: string }): Promise<{ error: string | null }>;
}

async function seedMockSchedule(
  workspace: SeededWorkspace,
  name: string,
  model = "ten-second-stream",
): Promise<string> {
  const client = workspace.client as unknown as ScheduleSeedClient;
  const result = await client.scheduleCreate({
    prompt: "Say hello from the scheduled agent.",
    name,
    cadence: { type: "cron", expression: "0 9 * * *" },
    target: {
      type: "new-agent",
      config: {
        provider: "mock",
        cwd: workspace.repoPath,
        model,
        modeId: "load-test",
        title: name,
      },
    },
    runOnCreate: false,
  });

  if (!result.schedule) {
    throw new Error(result.error ?? "Failed to seed schedule");
  }

  return result.schedule.id;
}

function ignoreScheduleDeleteError(): void {}

async function deleteSeededSchedule(workspace: SeededWorkspace, id: string): Promise<void> {
  await (workspace.client as unknown as ScheduleSeedClient)
    .scheduleDelete({ id })
    .catch(ignoreScheduleDeleteError);
}

test.describe("Schedules", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  test.afterEach(async () => {
    for (const cleanup of cleanupTasks.toReversed()) {
      await cleanup();
    }
    cleanupTasks.length = 0;
  });

  test("edit form hydrates the scheduled model selection", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "schedule-model-hydration-" });
    cleanupTasks.push(() => workspace.cleanup());
    const scheduleName = `Hydrate model ${Date.now()}`;
    const scheduleId = await seedMockSchedule(workspace, scheduleName);
    cleanupTasks.push(() => deleteSeededSchedule(workspace, scheduleId));

    await page.goto(buildSchedulesRoute());
    const row = page.getByTestId(`schedule-row-${scheduleId}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(workspace.projectDisplayName, { timeout: 30_000 });

    await row.click();
    const formSheet = page.getByTestId("schedule-form-sheet");
    await expect(formSheet).toBeVisible({ timeout: 10_000 });
    await expectStableHeight(formSheet);
    const hostTrigger = page.getByTestId("schedule-host-trigger");
    const projectTrigger = page.getByTestId("schedule-project-trigger");
    const modelTrigger = page.getByTestId("schedule-model-trigger");
    const thinkingTrigger = page.getByTestId("schedule-thinking-trigger");
    const modeTrigger = page.getByTestId("schedule-mode-trigger");
    await expect(hostTrigger).toBeVisible({ timeout: 30_000 });
    await expect(hostTrigger).toBeDisabled();
    await expectSettled(hostTrigger);
    await expect(projectTrigger).toContainText(workspace.projectDisplayName, { timeout: 30_000 });
    await expectSettled(projectTrigger);
    await expect(modelTrigger).toContainText("Ten second stream", { timeout: 30_000 });
    await expectSettled(modelTrigger);
    await expect(thinkingTrigger).toContainText("Low");
    await expectSettled(thinkingTrigger);
    await expect(modeTrigger).toBeVisible({ timeout: 30_000 });
    await expectSettled(modeTrigger);
    await expect(page.getByTestId("cadence-mode")).toHaveCount(0);
    await expect(page.getByTestId("cadence-interval-value")).toHaveCount(0);
    await expect(page.getByTestId("schedule-cadence-preset-trigger")).toContainText("Daily 9:00");
    await expect(page.getByText(/Times are in/)).toHaveCount(0);
    await expect(formSheet.getByText("Cron", { exact: true })).toHaveCount(0);
  });

  test("edit form hydrates a non-default host schedule after reload", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "schedule-host-b-hydration-" });
    cleanupTasks.push(() => workspace.cleanup());
    const secondary = await createScheduleHost();
    cleanupTasks.push(() => secondary.cleanup());
    const scheduleId = await seedMockSchedule(
      secondary,
      "Secondary host schedule",
      SECONDARY_MODEL_ID,
    );
    cleanupTasks.push(() => deleteSeededSchedule(secondary, scheduleId));

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await page.goto(buildSchedulesRoute());
    await addScheduleHostAndReload({
      page,
      serverId: secondary.serverId,
      label: secondary.label,
      port: secondary.port,
    });
    await page.reload();

    const row = page.getByTestId(`schedule-row-${scheduleId}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();

    const formSheet = page.getByTestId("schedule-form-sheet");
    await expect(formSheet).toBeVisible({ timeout: 10_000 });
    await expectStableHeight(formSheet);
    const hostTrigger = page.getByTestId("schedule-host-trigger");
    const projectTrigger = page.getByTestId("schedule-project-trigger");
    const modelTrigger = page.getByTestId("schedule-model-trigger");
    const modeTrigger = page.getByTestId("schedule-mode-trigger");

    await expect(hostTrigger).toContainText(secondary.label, { timeout: 30_000 });
    await expect(hostTrigger).toBeDisabled();
    await expectSettled(hostTrigger);
    await expect(projectTrigger).toContainText(secondary.projectDisplayName, { timeout: 30_000 });
    await expectSettled(projectTrigger);
    await expect(modelTrigger).toContainText(SECONDARY_MODEL_LABEL, { timeout: 30_000 });
    await expectSettled(modelTrigger);
    await expect(modeTrigger).toContainText("Load Test", { timeout: 30_000 });
    await expectSettled(modeTrigger);
    await expect(page.getByTestId("cadence-mode")).toHaveCount(0);
    await expect(page.getByTestId("schedule-cadence-preset-trigger")).toContainText("Daily 9:00");
  });

  test("create opens pristine after closing an edit form", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "schedule-pristine-create-" });
    cleanupTasks.push(() => workspace.cleanup());
    const scheduleName = `Pristine create ${Date.now()}`;
    const scheduleId = await seedMockSchedule(workspace, scheduleName);
    cleanupTasks.push(() => deleteSeededSchedule(workspace, scheduleId));

    await page.goto(buildSchedulesRoute());
    const row = page.getByTestId(`schedule-row-${scheduleId}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    const formSheet = page.getByTestId("schedule-form-sheet");
    await expect(formSheet).toBeVisible({ timeout: 10_000 });
    await expectStableHeight(formSheet);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(formSheet).toHaveCount(0, { timeout: 30_000 });

    await page.getByTestId("schedules-new").click();
    await expect(formSheet).toBeVisible({ timeout: 10_000 });
    const projectTrigger = page.getByTestId("schedule-project-trigger");
    await expect(projectTrigger).toContainText(/select project/i);
    await expectSettled(projectTrigger);
    await expect(page.getByTestId("schedule-model-trigger")).toHaveCount(0);
    await expect(page.getByTestId("schedule-thinking-trigger")).toHaveCount(0);
    await expect(page.getByTestId("schedule-mode-trigger")).toHaveCount(0);
    await expect(page.getByTestId("cadence-interval-value")).toHaveCount(0);
  });
});
