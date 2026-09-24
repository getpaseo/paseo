import { expect, test } from "../support/fixtures";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
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
  schedulePause(input: { id: string }): Promise<{ error: string | null }>;
  scheduleDelete(input: { id: string }): Promise<{ error: string | null }>;
}

async function seedPausedSchedule(workspace: SeededWorkspace, name: string): Promise<string> {
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
        model: "ten-second-stream",
        modeId: "load-test",
        title: name,
      },
    },
    runOnCreate: false,
  });
  if (!result.schedule) {
    throw new Error(result.error ?? "Failed to seed schedule");
  }
  const scheduleId = result.schedule.id;
  const paused = await client.schedulePause({ id: scheduleId });
  if (paused.error) {
    throw new Error(paused.error);
  }
  return scheduleId;
}

function ignoreScheduleDeleteError(): void {}

async function deleteSeededSchedule(workspace: SeededWorkspace, id: string): Promise<void> {
  await (workspace.client as unknown as ScheduleSeedClient)
    .scheduleDelete({ id })
    .catch(ignoreScheduleDeleteError);
}

test.describe("Schedule relative timestamps", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  test.afterEach(async () => {
    for (const cleanup of cleanupTasks.toReversed()) {
      await cleanup();
    }
    cleanupTasks.length = 0;
  });

  test("an idle schedule row keeps its created age current", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "schedule-relative-time-", git: false });
    cleanupTasks.push(() => workspace.cleanup());
    const scheduleId = await seedPausedSchedule(workspace, `Relative time ${Date.now()}`);
    cleanupTasks.push(() => deleteSeededSchedule(workspace, scheduleId));

    await page.clock.install({ time: Date.now() });
    await page.goto(buildSchedulesRoute());
    const row = page.getByTestId(`schedule-row-${scheduleId}`);
    await expect(row).toContainText("Created just now", { timeout: 30_000 });

    await page.clock.fastForward("03:00");

    await expect(row).toContainText("Created 3m ago");
  });
});
