import { expect, test, type Page } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import {
  addFakeScheduleHostAndReload,
  buildFakeScheduleHostWorkspace,
  installFakeScheduleHost,
} from "./helpers/schedule-fake-host";
import { getServerId } from "./helpers/server-id";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";
import { waitForSidebarHydration } from "./helpers/workspace-ui";
import { buildSchedulesRoute } from "../src/utils/host-routes";

interface ScheduleListItem {
  id: string;
  name: string | null;
  target: { type: string; config?: { cwd?: string } };
}

interface ScheduleSeedClient {
  scheduleList(): Promise<{ schedules: ScheduleListItem[]; error: string | null }>;
  scheduleDelete(input: { id: string }): Promise<{ error: string | null }>;
}

async function selectModelByLabel(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: /select model/i }).click();
  const popup = page.getByTestId("combobox-desktop-container");
  await expect(popup).toBeVisible({ timeout: 30_000 });
  await popup.getByText(label, { exact: true }).click();
  await expect(popup).toHaveCount(0, { timeout: 30_000 });
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
  const cleanupTasks: Array<() => Promise<void>> = [];

  test.afterEach(async () => {
    for (const cleanup of cleanupTasks.toReversed()) {
      await cleanup();
    }
    cleanupTasks.length = 0;
  });

  test("creates a schedule from a project picker instead of a raw CWD selector", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "schedule-project-target-" });
    cleanupTasks.push(() => workspace.cleanup());
    const scheduleName = `Project schedule ${Date.now()}`;
    cleanupTasks.push(() => deleteScheduleByName(workspace, scheduleName));

    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    await page.getByRole("button", { name: "Schedules" }).click();
    await expect(page).toHaveURL(/\/schedules$/);
    await expect(page).not.toHaveURL(/\/h\//);
    await expect(page.getByTestId(`schedules-section-${getServerId()}`)).toBeVisible();

    await page.getByRole("button", { name: "New schedule" }).click();
    await expect(page.getByTestId("schedule-form-sheet")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("schedule-cwd-trigger")).toHaveCount(0);

    await page.getByRole("button", { name: /select project/i }).click();
    await page.getByTestId(`schedule-project-option-${workspace.projectId}`).click();
    await expect(page.getByRole("button", { name: /select project/i })).toContainText(
      workspace.projectDisplayName,
    );

    await page.getByLabel("Schedule name").fill(scheduleName);
    await page.getByLabel("Prompt").fill("Summarize the project status.");
    await page.getByRole("button", { name: "Cron" }).click();
    await page.getByRole("button", { name: "Create schedule" }).click();

    await expect(page.getByTestId("schedule-form-sheet")).toHaveCount(0, { timeout: 30_000 });
    await expectScheduleCreatedForProject({ workspace, name: scheduleName });
  });

  test("clears the selected model when the chosen project moves to another host", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "schedule-project-host-model-" });
    cleanupTasks.push(() => workspace.cleanup());
    const fakeHost = await buildFakeScheduleHostWorkspace(workspace);
    const fakePort = String(59_000 + Math.floor(Math.random() * 900));

    await installFakeScheduleHost({
      page,
      port: fakePort,
      serverId: fakeHost.serverId,
      workspace: fakeHost.workspace,
    });

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await page.goto(buildSchedulesRoute());
    await addFakeScheduleHostAndReload({
      page,
      serverId: fakeHost.serverId,
      label: "Fake host",
      port: fakePort,
    });
    await expect(page.getByTestId(`schedules-section-${fakeHost.serverId}`)).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "New schedule" }).click();
    await expect(page.getByTestId("schedule-form-sheet")).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: /select project/i }).click();
    await page.getByTestId(`schedule-project-option-${workspace.projectId}`).click();
    await expect(page.getByRole("button", { name: /select project/i })).toContainText(
      workspace.projectDisplayName,
    );

    await selectModelByLabel(page, "Ten second stream");
    await expect(page.getByRole("button", { name: /ten second stream/i })).toBeVisible();

    await page.getByRole("button", { name: /select project/i }).click();
    await page.getByTestId(`schedule-project-option-${fakeHost.projectId}`).click();
    await expect(page.getByRole("button", { name: /select project/i })).toContainText(
      fakeHost.projectDisplayName,
    );
    await expect(page.getByRole("button", { name: /select model/i })).toBeVisible();

    await page.getByLabel("Schedule name").fill(`Cross host model ${Date.now()}`);
    await page.getByLabel("Prompt").fill("Run on the fake host project.");
    await expect(page.getByRole("button", { name: "Create schedule" })).toBeDisabled();
  });
});
