import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { escapeRegex } from "../support/helpers/regex";
import { expectSettled, expectStableHeight } from "../support/helpers/settled";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { buildHostWorkspaceRoute, buildSchedulesRoute } from "../../src/utils/host-routes";

const REPORT_WORKSPACE_NAME = "Weekly report";

interface ScheduleListItem {
  id: string;
  name: string | null;
  target: {
    type: string;
    config?: {
      cwd?: string;
      workspaceId?: string;
      archiveOnFinish?: boolean;
      isolation?: "local" | "worktree";
    };
  };
}

interface ScheduleSeedClient {
  scheduleCreate(input: {
    prompt: string;
    name?: string;
    cadence: { type: "cron"; expression: string };
    target: {
      type: "new-agent";
      config: {
        provider: "mock";
        workspaceId: string;
        model: string;
        modeId: string;
        title: string;
      };
    };
    runOnCreate: boolean;
  }): Promise<{ schedule: { id: string } | null; error: string | null }>;
  scheduleList(): Promise<{ schedules: ScheduleListItem[]; error: string | null }>;
  scheduleDelete(input: { id: string }): Promise<{ error: string | null }>;
}

interface RestorableClient {
  restoreWorkspace(workspaceId: string): Promise<void>;
}

interface ReportWorkspace {
  id: string;
  workspaceDirectory: string;
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

async function createReportWorkspace(project: SeededWorkspace): Promise<ReportWorkspace> {
  const created = await project.client.createWorkspace({
    source: {
      kind: "worktree",
      cwd: project.repoPath,
      projectId: project.projectId,
      worktreeSlug: "weekly-report",
    },
    title: REPORT_WORKSPACE_NAME,
  });
  if (!created.workspace) {
    throw new Error(created.error ?? "Failed to create the report workspace");
  }
  return { id: created.workspace.id, workspaceDirectory: created.workspace.workspaceDirectory };
}

// A workspace on the project's own directory. Archiving and restoring one only flips its record,
// where a worktree workspace recreates its checkout on restore.
async function createLocalReportWorkspace(project: SeededWorkspace): Promise<ReportWorkspace> {
  const created = await project.client.createWorkspace({
    source: { kind: "directory", path: project.repoPath, projectId: project.projectId },
    title: REPORT_WORKSPACE_NAME,
  });
  if (!created.workspace) {
    throw new Error(created.error ?? "Failed to create the local report workspace");
  }
  return { id: created.workspace.id, workspaceDirectory: created.workspace.workspaceDirectory };
}

async function seedBoundSchedule(
  project: SeededWorkspace,
  workspace: ReportWorkspace,
  name: string,
): Promise<string> {
  const client = project.client as unknown as ScheduleSeedClient;
  const result = await client.scheduleCreate({
    prompt: "Summarize the week.",
    name,
    cadence: { type: "cron", expression: "0 9 * * *" },
    target: {
      type: "new-agent",
      config: {
        provider: "mock",
        workspaceId: workspace.id,
        model: "ten-second-stream",
        modeId: "load-test",
        title: name,
      },
    },
    runOnCreate: false,
  });
  if (!result.schedule) {
    throw new Error(result.error ?? "Failed to seed the bound schedule");
  }
  return result.schedule.id;
}

async function findSchedule(project: SeededWorkspace, name: string): Promise<ScheduleListItem> {
  const client = project.client as unknown as ScheduleSeedClient;
  const list = await client.scheduleList();
  const schedule = list.schedules.find((candidate) => candidate.name === name);
  if (!schedule) {
    throw new Error(`Expected schedule named ${name} to exist`);
  }
  return schedule;
}

function ignoreCleanupError(): void {}

async function deleteScheduleByName(project: SeededWorkspace, name: string): Promise<void> {
  const client = project.client as unknown as ScheduleSeedClient;
  const list = await client.scheduleList();
  const schedule = list.schedules.find((candidate) => candidate.name === name);
  if (schedule) {
    await client.scheduleDelete({ id: schedule.id }).catch(ignoreCleanupError);
  }
}

test.describe("Schedules workspace target", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  test.afterEach(async () => {
    for (const cleanup of cleanupTasks.toReversed()) {
      await cleanup();
    }
    cleanupTasks.length = 0;
  });

  test("creates a schedule that runs in an existing workspace", async ({ page }) => {
    const project = await seedWorkspace({ repoPrefix: "schedule-workspace-create-" });
    cleanupTasks.push(() => project.cleanup());
    const report = await createReportWorkspace(project);
    const scheduleName = `Workspace schedule ${Date.now()}`;
    cleanupTasks.push(() => deleteScheduleByName(project, scheduleName));

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await page.goto(buildSchedulesRoute());
    await page.getByTestId("schedules-empty-new").click();
    const formSheet = page.getByTestId("schedule-form-sheet");
    await expect(formSheet).toBeVisible({ timeout: 10_000 });
    await expectStableHeight(formSheet);
    await expect(page.getByTestId("schedule-workspace-trigger")).toHaveCount(0);

    await page.getByRole("button", { name: /select project/i }).click();
    await page
      .getByTestId(`schedule-project-option-${projectEquivalenceViewKey(project.projectKey)}`)
      .click();
    const workspaceTrigger = page.getByTestId("schedule-workspace-trigger");
    await expect(workspaceTrigger).toContainText("New workspace each run");
    await expectSettled(workspaceTrigger);
    await selectModelByLabel(page, "Ten second stream");
    await expect(page.getByTestId("schedule-isolation-trigger")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("schedule-archive-on-finish-switch")).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await workspaceTrigger.click();
    await expect(page.getByTestId("schedule-workspace-option-new")).toBeVisible();
    await expect(page.getByTestId(`schedule-workspace-option-${report.id}`)).toBeVisible();
    await page.getByTestId(`schedule-workspace-option-${report.id}`).click();

    await expect(workspaceTrigger).toContainText(REPORT_WORKSPACE_NAME);
    await expectSettled(workspaceTrigger);
    await expect(page.getByTestId("schedule-isolation-trigger")).toHaveCount(0);
    await expect(page.getByTestId("schedule-archive-on-finish-switch")).toHaveAttribute(
      "aria-checked",
      "false",
    );

    await page.getByTestId("schedule-cadence-preset-trigger").click();
    await page.getByTestId("schedule-cadence-preset-every-hour").click();
    await page.getByLabel("Schedule name").fill(scheduleName);
    await page.getByLabel("Prompt").fill("Summarize the week.");
    await page.getByRole("button", { name: "Create schedule" }).click();
    await expect(page.getByTestId("schedule-form-sheet")).toHaveCount(0, { timeout: 30_000 });

    const schedule = await findSchedule(project, scheduleName);
    expect(schedule.target.config).toEqual(
      expect.objectContaining({
        workspaceId: report.id,
        cwd: report.workspaceDirectory,
        archiveOnFinish: false,
      }),
    );
    expect(schedule.target.config?.isolation).toBeUndefined();

    const row = page.getByTestId(`schedule-row-${schedule.id}`);
    await expect(row).toContainText(REPORT_WORKSPACE_NAME, { timeout: 30_000 });
    await expect(row).toContainText("Active");
  });

  test("opens the bound workspace from the row menu", async ({ page }) => {
    const project = await seedWorkspace({ repoPrefix: "schedule-workspace-open-" });
    cleanupTasks.push(() => project.cleanup());
    const report = await createReportWorkspace(project);
    const scheduleName = `Open workspace ${Date.now()}`;
    const scheduleId = await seedBoundSchedule(project, report, scheduleName);
    cleanupTasks.push(() => deleteScheduleByName(project, scheduleName));

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await page.goto(buildSchedulesRoute());
    const row = page.getByTestId(`schedule-row-${scheduleId}`);
    await expect(row).toContainText(REPORT_WORKSPACE_NAME, { timeout: 30_000 });

    await page.getByTestId(`schedule-kebab-${scheduleId}`).click();
    await page.getByTestId(`schedule-menu-open-workspace-${scheduleId}`).click();

    await expect(page).toHaveURL(
      new RegExp(escapeRegex(buildHostWorkspaceRoute(getServerId(), report.id))),
    );
  });

  test("shows target gone once the workspace is archived and active again after it is restored", async ({
    page,
  }) => {
    const project = await seedWorkspace({ repoPrefix: "schedule-workspace-gone-" });
    cleanupTasks.push(() => project.cleanup());
    const report = await createLocalReportWorkspace(project);
    const scheduleName = `Archived workspace ${Date.now()}`;
    const scheduleId = await seedBoundSchedule(project, report, scheduleName);
    cleanupTasks.push(() => deleteScheduleByName(project, scheduleName));

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await page.goto(buildSchedulesRoute());
    const row = page.getByTestId(`schedule-row-${scheduleId}`);
    await expect(row).toContainText("Active", { timeout: 30_000 });

    const archived = await project.client.archiveWorkspace(report.id);
    expect(archived.error).toBeNull();

    // A schedule whose target is gone moves from the Active list to Ended.
    await expect(row).toHaveCount(0, { timeout: 30_000 });
    await page.getByTestId("schedules-filter-ended").click();
    await expect(row).toContainText("Target gone", { timeout: 30_000 });
    await expect(row).toContainText("Workspace unavailable");

    // The menu keeps Open workspace but disables it: the workspace page has nothing to show
    // for a workspace that is gone.
    const kebab = page.getByTestId(`schedule-kebab-${scheduleId}`);
    const openWorkspace = page.getByTestId(`schedule-menu-open-workspace-${scheduleId}`);
    await kebab.click();
    await expect(openWorkspace).toBeVisible();
    await expect(openWorkspace).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(openWorkspace).toHaveCount(0);

    await (project.client as unknown as RestorableClient).restoreWorkspace(report.id);

    await expect(row).toHaveCount(0, { timeout: 30_000 });
    await page.getByTestId("schedules-filter-active").click();
    await expect(row).toContainText("Active", { timeout: 30_000 });
    await expect(row).toContainText(REPORT_WORKSPACE_NAME);
    await kebab.click();
    await expect(openWorkspace).toBeEnabled();
  });

  test("edits a bound schedule back to a new workspace per run", async ({ page }) => {
    const project = await seedWorkspace({ repoPrefix: "schedule-workspace-unbind-" });
    cleanupTasks.push(() => project.cleanup());
    const report = await createReportWorkspace(project);
    const scheduleName = `Unbind workspace ${Date.now()}`;
    const scheduleId = await seedBoundSchedule(project, report, scheduleName);
    cleanupTasks.push(() => deleteScheduleByName(project, scheduleName));

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await page.goto(buildSchedulesRoute());
    await page.getByTestId(`schedule-row-${scheduleId}`).click();
    const formSheet = page.getByTestId("schedule-form-sheet");
    await expect(formSheet).toBeVisible({ timeout: 10_000 });
    await expectStableHeight(formSheet);

    const workspaceTrigger = page.getByTestId("schedule-workspace-trigger");
    await expect(workspaceTrigger).toContainText(REPORT_WORKSPACE_NAME, { timeout: 30_000 });
    await expect(page.getByTestId("schedule-project-trigger")).toContainText(
      project.projectDisplayName,
    );
    await expect(page.getByTestId("schedule-isolation-trigger")).toHaveCount(0);

    await workspaceTrigger.click();
    await page.getByTestId("schedule-workspace-option-new").click();
    await expect(workspaceTrigger).toContainText("New workspace each run");
    await expect(page.getByTestId("schedule-isolation-trigger")).toBeVisible();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByTestId("schedule-form-sheet")).toHaveCount(0, { timeout: 30_000 });

    const schedule = await findSchedule(project, scheduleName);
    expect(schedule.target.config?.workspaceId).toBeUndefined();
    expect(schedule.target.config?.cwd).toBe(project.repoPath);
  });
});
