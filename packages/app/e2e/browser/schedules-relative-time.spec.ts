import { expect, test, type Page } from "../support/fixtures";
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

/** Opens Schedules with the browser clock frozen at `time`, so the page cannot age it. */
async function openSchedulesAt(page: Page, time: number): Promise<void> {
  await page.clock.install({ time });
  await page.goto(buildSchedulesRoute());
}

async function letTimePass(page: Page, duration: string): Promise<void> {
  await page.clock.fastForward(duration);
}

async function expectScheduleRowText(page: Page, scheduleId: string, text: string): Promise<void> {
  await expect(page.getByTestId(`schedule-row-${scheduleId}`)).toContainText(text, {
    timeout: 30_000,
  });
}

test.describe("Schedule relative timestamps", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  test.afterEach(async () => {
    const failures: unknown[] = [];
    for (const cleanup of cleanupTasks.toReversed()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    cleanupTasks.length = 0;
    if (failures.length > 0) {
      throw new AggregateError(failures, "Test cleanup failed");
    }
  });

  test("an idle schedule row keeps its created age current", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "schedule-relative-time-", git: false });
    cleanupTasks.push(() => workspace.cleanup());
    const schedule = await seedPausedSchedule(workspace, `Relative time ${Date.now()}`);
    cleanupTasks.push(() => deleteSeededSchedule(workspace, schedule.id));

    await openSchedulesAt(page, schedule.createdAt);
    await expectScheduleRowText(page, schedule.id, "Created just now");

    await letTimePass(page, "03:00");

    await expectScheduleRowText(page, schedule.id, "Created 3m ago");
  });
});
