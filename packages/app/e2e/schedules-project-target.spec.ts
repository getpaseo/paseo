import { expect, test, type Page } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import {
  addFakeScheduleHostAndReload,
  buildFakeScheduleHostWorkspace,
  installFakeScheduleHost,
} from "./helpers/schedule-fake-host";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";
import { escapeRegex } from "./helpers/regex";
import { expectNoTruncation } from "./helpers/no-truncation";
import { expectSettled, expectStableHeight } from "./helpers/settled";
import { waitForSidebarHydration } from "./helpers/workspace-ui";
import { buildSchedulesRoute } from "../src/utils/host-routes";

const MOBILE_SHEET_VIEWPORT = { width: 390, height: 844 };

interface ScheduleListItem {
  id: string;
  name: string | null;
  cadence?: { type: "cron"; expression: string };
  target: {
    type: string;
    config?: {
      cwd?: string;
      archiveOnFinish?: boolean;
      isolation?: "local" | "worktree";
    };
  };
}

interface ScheduleSeedClient {
  scheduleList(): Promise<{ schedules: ScheduleListItem[]; error: string | null }>;
  scheduleDelete(input: { id: string }): Promise<{ error: string | null }>;
}

async function selectModelByLabel(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: /select model/i }).click();
  const popup = page.getByTestId("combobox-desktop-container");
  await expect(popup).toBeVisible({ timeout: 30_000 });
  const searchInput = page.getByTestId("model-search-input").first();
  await expect(searchInput).toBeVisible({ timeout: 30_000 });
  await searchInput.fill(label);
  const option = popup.getByText(new RegExp(`^${escapeRegex(label)}$`, "i")).first();
  await expect(option).toBeVisible({ timeout: 30_000 });
  await option.click();
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
  cadenceExpression: string;
}): Promise<void> {
  const client = input.workspace.client as unknown as ScheduleSeedClient;
  const list = await client.scheduleList();
  const schedule = list.schedules.find((candidate) => candidate.name === input.name);
  expect(schedule).toEqual(
    expect.objectContaining({
      name: input.name,
      cadence: expect.objectContaining({
        type: "cron",
        expression: input.cadenceExpression,
      }),
      target: expect.objectContaining({
        type: "new-agent",
        config: expect.objectContaining({
          cwd: input.workspace.repoPath,
        }),
      }),
    }),
  );
}

async function expectScheduleKnobs(input: {
  workspace: SeededWorkspace;
  name: string;
  archiveOnFinish: boolean;
  isolation: "local" | "worktree";
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
          archiveOnFinish: input.archiveOnFinish,
          isolation: input.isolation,
        }),
      }),
    }),
  );
}

async function openNewScheduleSheet(page: Page): Promise<void> {
  await page.getByTestId("schedules-empty-new").click();
  const formSheet = page.getByTestId("schedule-form-sheet");
  await expect(formSheet).toBeVisible({ timeout: 10_000 });
  await expectStableHeight(formSheet);
}

function bottomSheetBackdrop(page: Page) {
  return page.getByRole("button", { name: "Bottom sheet backdrop" }).first();
}

async function dismissScheduleSheetWithBackdrop(page: Page): Promise<void> {
  const backdrop = bottomSheetBackdrop(page);
  await expect(backdrop).toBeVisible({ timeout: 10_000 });
  await expect(async () => {
    const box = await backdrop.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + 24);
    }
    await expect(backdrop).not.toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

async function expectScheduleSheetClosedAndStable(page: Page): Promise<void> {
  const formSheet = page.getByTestId("schedule-form-sheet");
  await expect(formSheet).toHaveCount(0, { timeout: 30_000 });
  await page.waitForTimeout(500);
  await expect(formSheet).toHaveCount(0, { timeout: 1_000 });
}

async function findScheduleIdByName(workspace: SeededWorkspace, name: string): Promise<string> {
  const client = workspace.client as unknown as ScheduleSeedClient;
  const list = await client.scheduleList();
  const schedule = list.schedules.find((candidate) => candidate.name === name);
  if (!schedule) {
    throw new Error(`Expected schedule named ${name} to exist`);
  }
  return schedule.id;
}

test.describe("Schedules project target", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  test.afterEach(async () => {
    for (const cleanup of cleanupTasks.toReversed()) {
      await cleanup();
    }
    cleanupTasks.length = 0;
  });

  test("dismisses the new schedule sheet without reopening", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "schedule-sheet-dismiss-", git: false });
    cleanupTasks.push(() => workspace.cleanup());

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await page.goto(buildSchedulesRoute());
    await page.setViewportSize(MOBILE_SHEET_VIEWPORT);
    await expect(page.getByTestId("schedules-empty-new")).toBeVisible({ timeout: 30_000 });

    await openNewScheduleSheet(page);
    await dismissScheduleSheetWithBackdrop(page);
    await expectScheduleSheetClosedAndStable(page);
    await expect(page.getByTestId("schedules-empty-new")).toBeVisible({ timeout: 30_000 });

    await openNewScheduleSheet(page);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expectScheduleSheetClosedAndStable(page);
  });

  test("creates a schedule from a project picker instead of a raw CWD selector", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "schedule-project-target-", git: false });
    cleanupTasks.push(() => workspace.cleanup());
    const scheduleName = `Project schedule ${Date.now()}`;
    cleanupTasks.push(() => deleteScheduleByName(workspace, scheduleName));

    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    await page.getByRole("button", { name: "Schedules" }).click();
    await expect(page).toHaveURL(/\/schedules$/);
    await expect(page).not.toHaveURL(/\/h\//);
    await expect(page.getByTestId("schedules-empty")).toBeVisible();

    await page.getByTestId("schedules-empty-new").click();
    const formSheet = page.getByTestId("schedule-form-sheet");
    await expect(formSheet).toBeVisible({ timeout: 10_000 });
    await expectStableHeight(formSheet);
    await expect(page.getByTestId("schedule-host-trigger")).toHaveCount(0);
    await expect(page.getByTestId("schedule-project-trigger")).toBeVisible();
    await expect(page.getByTestId("schedule-model-trigger")).toHaveCount(0);
    await expect(page.getByTestId("schedule-thinking-trigger")).toHaveCount(0);
    await expect(page.getByTestId("schedule-mode-trigger")).toHaveCount(0);
    await expect(page.getByTestId("cadence-mode")).toHaveCount(0);
    await expect(page.getByTestId("cadence-interval-value")).toHaveCount(0);
    await expect(page.getByText(/Times are in/)).toHaveCount(0);
    await expect(formSheet.getByText("Cron", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: /select project/i }).click();
    await page.getByTestId(`schedule-project-option-${workspace.projectId}`).click();
    const projectTrigger = page.getByTestId("schedule-project-trigger");
    await expect(projectTrigger).toContainText(workspace.projectDisplayName);
    await expectSettled(projectTrigger);

    await selectModelByLabel(page, "Ten second stream");
    const modelTrigger = page.getByTestId("schedule-model-trigger");
    await expect(modelTrigger).toContainText("Ten second stream");
    await expectSettled(modelTrigger);
    await expect(page.getByTestId("schedule-thinking-trigger")).toHaveCount(0);
    await expect(page.getByTestId("schedule-mode-trigger")).toBeVisible();
    await expectSettled(page.getByTestId("schedule-mode-trigger"));
    await expect(page.getByTestId("schedule-isolation-trigger")).toHaveCount(0);
    await expect(page.getByText("Worktree isolation is available for git projects.")).toHaveCount(
      0,
    );

    await page.getByTestId("schedule-cadence-preset-trigger").click();
    await page.getByTestId("schedule-cadence-preset-daily-9").click();
    await expect(page.getByTestId("schedule-cadence-preset-trigger")).toContainText("Daily 9:00");
    await expect(page.getByTestId("cadence-cron-expression")).toHaveValue("0 9 * * *");

    await page.getByLabel("Schedule name").fill(scheduleName);
    await page.getByLabel("Prompt").fill("Summarize the project status.");
    await page.getByRole("button", { name: "Create schedule" }).click();

    await expect(page.getByTestId("schedule-form-sheet")).toHaveCount(0, { timeout: 30_000 });
    await expectScheduleCreatedForProject({
      workspace,
      name: scheduleName,
      cadenceExpression: "0 9 * * *",
    });

    const fakeHost = await buildFakeScheduleHostWorkspace(workspace);
    const fakePort = String(59_000 + Math.floor(Math.random() * 900));
    await installFakeScheduleHost({
      page,
      port: fakePort,
      serverId: fakeHost.serverId,
      workspace: fakeHost.workspace,
    });
    await addFakeScheduleHostAndReload({
      page,
      serverId: fakeHost.serverId,
      label: "Fake host",
      port: fakePort,
    });

    const hostFilterTrigger = page.getByTestId("schedules-host-filter-trigger");
    await expect(hostFilterTrigger).toBeVisible({ timeout: 30_000 });
    await hostFilterTrigger.click();
    const hostFilterPopup = page.getByTestId("combobox-desktop-container").last();
    await expect(hostFilterPopup).toBeVisible({ timeout: 30_000 });
    await expectNoTruncation(hostFilterPopup);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("combobox-desktop-container")).toHaveCount(0, {
      timeout: 5_000,
    });
  });

  test("clears the selected project and model when the host changes", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "schedule-project-host-model-" });
    cleanupTasks.push(() => workspace.cleanup());
    const serverId = getServerId();
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
    await expect(page.getByTestId("schedules-empty")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("schedules-empty-new").click();
    const formSheet = page.getByTestId("schedule-form-sheet");
    await expect(formSheet).toBeVisible({ timeout: 10_000 });
    await expectStableHeight(formSheet);

    const hostTrigger = page.getByTestId("schedule-host-trigger");
    const projectTrigger = page.getByTestId("schedule-project-trigger");
    const modelTrigger = page.getByTestId("schedule-model-trigger");
    const thinkingTrigger = page.getByTestId("schedule-thinking-trigger");
    const modeTrigger = page.getByTestId("schedule-mode-trigger");
    await expect(hostTrigger).toBeVisible({ timeout: 30_000 });
    await expect(projectTrigger).toHaveCount(0);
    await expect(modelTrigger).toHaveCount(0);
    await expect(thinkingTrigger).toHaveCount(0);
    await expect(modeTrigger).toHaveCount(0);
    await hostTrigger.click();
    await page.getByTestId(`schedule-host-option-${serverId}`).click();
    await expect(projectTrigger).toBeVisible();
    await expect(modelTrigger).toHaveCount(0);
    await expect(thinkingTrigger).toHaveCount(0);
    await expect(modeTrigger).toHaveCount(0);
    await expectSettled(hostTrigger);

    await projectTrigger.click();
    await page.getByTestId(`schedule-project-option-${workspace.projectId}`).click();
    await expect(projectTrigger).toContainText(workspace.projectDisplayName);
    await expectSettled(projectTrigger);

    await selectModelByLabel(page, "Ten second stream");
    await expect(modelTrigger).toContainText("Ten second stream");
    await expectSettled(modelTrigger);
    await expect(thinkingTrigger).toHaveCount(0);
    await expect(modeTrigger).toBeVisible();
    await expectSettled(modeTrigger);

    await hostTrigger.click();
    await page.getByTestId(`schedule-host-option-${fakeHost.serverId}`).click();
    await expect(hostTrigger).toContainText("Fake host");
    await expect(projectTrigger).toContainText(/select project/i);
    await expect(modelTrigger).toHaveCount(0);
    await expect(thinkingTrigger).toHaveCount(0);
    await expect(modeTrigger).toHaveCount(0);
    await expectSettled(hostTrigger);
    await expectSettled(projectTrigger);

    await projectTrigger.click();
    await expect(page.getByTestId(`schedule-project-option-${workspace.projectId}`)).toHaveCount(0);
    await page.getByTestId(`schedule-project-option-${fakeHost.projectId}`).click();
    await expect(projectTrigger).toContainText(fakeHost.projectDisplayName);
    await expectSettled(projectTrigger);
    await expect(modelTrigger).toContainText(/select model/i);
    await expectSettled(modelTrigger);
    await expect(thinkingTrigger).toHaveCount(0);
    await expect(modeTrigger).toHaveCount(0);

    await page.getByLabel("Schedule name").fill(`Cross host model ${Date.now()}`);
    await page.getByLabel("Prompt").fill("Run on the fake host project.");
    await expect(page.getByRole("button", { name: "Create schedule" })).toBeDisabled();
  });

  test("creates and edits schedule isolation and archive cleanup knobs", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "schedule-knobs-" });
    cleanupTasks.push(() => workspace.cleanup());
    const scheduleName = `Knob schedule ${Date.now()}`;
    cleanupTasks.push(() => deleteScheduleByName(workspace, scheduleName));

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await page.goto(buildSchedulesRoute());
    await expect(page.getByTestId("schedules-empty-new")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("schedules-empty-new").click();

    await page.getByRole("button", { name: /select project/i }).click();
    await page.getByTestId(`schedule-project-option-${workspace.projectId}`).click();
    await selectModelByLabel(page, "Ten second stream");
    await expect(
      page.getByText("Off keeps each run's workspace in the sidebar for inspection."),
    ).toHaveCount(0);
    await page.getByTestId("schedule-isolation-trigger").click();
    await page.getByTestId("schedule-isolation-worktree").click();
    await expect(page.getByTestId("schedule-isolation-trigger")).toContainText("Worktree");
    await page.getByTestId("schedule-archive-on-finish-switch").click();
    await page.getByLabel("Schedule name").fill(scheduleName);
    await page.getByLabel("Prompt").fill("Run with custom workspace cleanup.");
    await page.getByTestId("schedule-cadence-preset-trigger").click();
    await page.getByTestId("schedule-cadence-preset-every-hour").click();
    await page.getByRole("button", { name: "Create schedule" }).click();

    await expect(page.getByTestId("schedule-form-sheet")).toHaveCount(0, { timeout: 30_000 });
    await expectScheduleKnobs({
      workspace,
      name: scheduleName,
      archiveOnFinish: false,
      isolation: "worktree",
    });

    const scheduleId = await findScheduleIdByName(workspace, scheduleName);
    await page.getByTestId(`schedule-row-${scheduleId}`).click();
    const formSheet = page.getByTestId("schedule-form-sheet");
    await expect(formSheet).toBeVisible({ timeout: 10_000 });
    await expectStableHeight(formSheet);
    await expect(page.getByTestId("schedule-isolation-trigger")).toContainText("Worktree");
    await expect(page.getByTestId("schedule-archive-on-finish-switch")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(
      page.getByText("Off keeps each run's workspace in the sidebar for inspection."),
    ).toHaveCount(0);

    await page.getByTestId("schedule-isolation-trigger").click();
    await page.getByTestId("schedule-isolation-local").click();
    await page.getByTestId("schedule-archive-on-finish-switch").click();
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect(page.getByTestId("schedule-form-sheet")).toHaveCount(0, { timeout: 30_000 });
    await expectScheduleKnobs({
      workspace,
      name: scheduleName,
      archiveOnFinish: true,
      isolation: "local",
    });
  });
});
