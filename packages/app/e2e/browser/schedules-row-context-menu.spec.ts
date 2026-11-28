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
  }): Promise<{ schedule: { id: string } | null; error: string | null }>;
  scheduleDelete(input: { id: string }): Promise<{ error: string | null }>;
}

async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

async function seedSchedule(workspace: SeededWorkspace, name: string): Promise<string> {
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
  return result.schedule.id;
}

test.describe("Schedule row context menu", () => {
  const cleanupTasks: (() => Promise<void>)[] = [];

  test.afterEach(async () => {
    for (const cleanup of cleanupTasks.toReversed()) {
      await cleanup();
    }
    cleanupTasks.length = 0;
  });

  test("right-clicking a schedule row opens its actions, headed by its name and ID, and copies the ID", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const workspace = await seedWorkspace({
      repoPrefix: "schedule-context-menu-",
      git: false,
    });
    cleanupTasks.push(() => workspace.cleanup());
    const name = `Context menu ${Date.now()}`;
    const id = await seedSchedule(workspace, name);
    cleanupTasks.push(async () => {
      const client = workspace.client as unknown as ScheduleSeedClient;
      await client.scheduleDelete({ id });
    });

    await page.goto(buildSchedulesRoute());
    const row = page.getByTestId(`schedule-row-${id}`);
    await expect(row).toBeVisible({ timeout: 30_000 });

    await row.click({ button: "right" });
    const menu = page.getByTestId(`schedule-context-menu-${id}`);
    await expect(menu).toBeVisible();
    // The menu names the schedule it acts on, and holds the same actions as the kebab.
    await expect(menu.getByTestId(`schedule-menu-header-${id}`)).toContainText(name);
    await expect(menu.getByTestId(`schedule-menu-header-${id}`)).toContainText(id);
    await expect(menu.getByTestId(`schedule-menu-edit-${id}`)).toBeVisible();
    await expect(menu.getByTestId(`schedule-menu-delete-${id}`)).toBeVisible();

    await menu.getByTestId(`schedule-menu-copy-id-${id}`).click();
    await expect(menu).toBeHidden();
    await expect(page.getByText("Copied Schedule ID", { exact: true })).toBeVisible();
    await expect.poll(() => readClipboard(page)).toBe(id);
    // A right-click never opens the editor the row's own click opens.
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("the kebab menu offers Copy schedule ID too", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const workspace = await seedWorkspace({
      repoPrefix: "schedule-kebab-copy-",
      git: false,
    });
    cleanupTasks.push(() => workspace.cleanup());
    const id = await seedSchedule(workspace, `Kebab copy ${Date.now()}`);
    cleanupTasks.push(async () => {
      const client = workspace.client as unknown as ScheduleSeedClient;
      await client.scheduleDelete({ id });
    });

    await page.goto(buildSchedulesRoute());
    await page.getByTestId(`schedule-kebab-${id}`).click({ timeout: 30_000 });
    await page.getByTestId(`schedule-menu-copy-id-${id}`).click();
    await expect.poll(() => readClipboard(page)).toBe(id);
  });
});
