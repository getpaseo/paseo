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
  }): Promise<{ schedule: { id: string; createdAt: string } | null; error: string | null }>;
  schedulePause(input: { id: string }): Promise<{ error: string | null }>;
  scheduleDelete(input: { id: string }): Promise<{ error: string | null }>;
}

interface SeededSchedule {
  id: string;
  createdAt: number;
}

async function seedPausedSchedule(
  workspace: SeededWorkspace,
  name: string,
): Promise<SeededSchedule> {
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
  const { id, createdAt } = result.schedule;
  const paused = await client.schedulePause({ id });
  if (paused.error) {
    throw new Error(paused.error);
  }
  return { id, createdAt: Date.parse(createdAt) };
}

async function deleteSeededSchedule(workspace: SeededWorkspace, id: string): Promise<void> {
  const client = workspace.client as unknown as ScheduleSeedClient;
  const result = await client.scheduleDelete({ id });
  if (result.error) {
    throw new Error(result.error);
  }
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
    const schedule = await seedPausedSchedule(workspace, `Relative time ${Date.now()}`);
    cleanupTasks.push(() => deleteSeededSchedule(workspace, schedule.id));

    // Anchored to the schedule's own creation time so setup and page load cannot age it.
    await page.clock.install({ time: schedule.createdAt });
    await page.goto(buildSchedulesRoute());
    const row = page.getByTestId(`schedule-row-${schedule.id}`);
    await expect(row).toContainText("Created just now", { timeout: 30_000 });

    await page.clock.fastForward("03:00");

    await expect(row).toContainText("Created 3m ago");
  });
});
