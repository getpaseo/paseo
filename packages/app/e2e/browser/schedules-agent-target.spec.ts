import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  addFakeScheduleHostAndReload,
  buildFakeScheduleHostWorkspace,
  installFakeScheduleHost,
} from "../support/helpers/schedule-fake-host";
import { seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";
import { buildHostAgentDetailRoute } from "../../src/utils/host-routes";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { expectStableHeight } from "../support/helpers/settled";
import { buildSchedulesRoute } from "../../src/utils/host-routes";

const MOBILE_SHEET_VIEWPORT = { width: 390, height: 844 };

interface ScheduleListItem {
  id: string;
  name: string | null;
  prompt: string;
  maxRuns: number | null;
  cadence?: { type: "cron"; expression: string };
  target: { type: string; agentId?: string };
}

interface ScheduleSeedClient {
  scheduleList(): Promise<{ schedules: ScheduleListItem[]; error: string | null }>;
  scheduleDelete(input: { id: string }): Promise<{ error: string | null }>;
}

async function findScheduleByName(
  client: ScheduleSeedClient,
  name: string,
): Promise<ScheduleListItem> {
  const list = await client.scheduleList();
  const schedule = list.schedules.find((candidate) => candidate.name === name);
  if (!schedule) {
    throw new Error(`Expected a schedule named ${name}`);
  }
  return schedule;
}

async function deleteScheduleByName(client: ScheduleSeedClient, name: string): Promise<void> {
  const list = await client.scheduleList();
  const schedule = list.schedules.find((candidate) => candidate.name === name);
  if (schedule) {
    await client.scheduleDelete({ id: schedule.id }).catch(() => undefined);
  }
}

async function openNewScheduleSheet(page: Page): Promise<void> {
  await page.getByTestId("schedules-empty-new").click();
  const formSheet = page.getByTestId("schedule-form-sheet");
  await expect(formSheet).toBeVisible({ timeout: 30_000 });
  await expectStableHeight(formSheet);
}

async function chooseHeartbeatTarget(page: Page): Promise<void> {
  await page.getByTestId("schedule-target-kind-agent").click();
  await expect(page.getByTestId("schedule-agent-trigger")).toBeVisible({ timeout: 30_000 });
}

test.describe("Schedules targeting an existing agent", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  test.afterEach(async () => {
    for (const cleanup of cleanupTasks.toReversed()) {
      await cleanup();
    }
    cleanupTasks.length = 0;
  });

  test("creates a heartbeat aimed at a running agent", async ({ page }) => {
    const scheduleName = `Heartbeat ${Date.now()}`;
    const agentTitle = `Heartbeat target ${Date.now()}`;
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "schedule-agent-target-",
      title: agentTitle,
    });
    const client = agent.client as unknown as ScheduleSeedClient;
    cleanupTasks.push(() => agent.cleanup());
    cleanupTasks.push(() => deleteScheduleByName(client, scheduleName));

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await page.goto(buildSchedulesRoute());
    await page.setViewportSize(MOBILE_SHEET_VIEWPORT);
    await openNewScheduleSheet(page);
    await chooseHeartbeatTarget(page);

    // The new-agent configuration is gone: a heartbeat reuses the agent it targets.
    await expect(page.getByTestId("schedule-project-trigger")).toHaveCount(0);
    await expect(page.getByTestId("schedule-model-trigger")).toHaveCount(0);
    await expect(page.getByTestId("schedule-isolation-trigger")).toHaveCount(0);

    await page.getByTestId("schedule-agent-trigger").click();
    await page.getByTestId(`schedule-agent-option-${agent.agentId}`).click();
    await page.getByTestId("schedule-name-input").fill(scheduleName);
    await page.getByTestId("schedule-prompt-input").fill("Continue where you left off");
    await page.getByTestId("schedule-max-runs-input").fill("1");
    await page.getByTestId("schedule-form-submit").click();
    await expect(page.getByTestId("schedule-form-sheet")).toHaveCount(0, { timeout: 30_000 });

    await expect(async () => {
      const schedule = await findScheduleByName(client, scheduleName);
      expect(schedule.target).toMatchObject({ type: "agent", agentId: agent.agentId });
      expect(schedule.prompt).toBe("Continue where you left off");
      expect(schedule.maxRuns).toBe(1);
      expect(schedule.cadence?.type).toBe("cron");
    }).toPass({ timeout: 30_000 });
  });

  test("distinguishes a still-loading agent directory from an empty one", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "schedule-agent-empty-", git: false });
    cleanupTasks.push(() => workspace.cleanup());
    const fakeHost = await buildFakeScheduleHostWorkspace(workspace);
    const fakePort = String(59_000 + Math.floor(Math.random() * 900));

    await installFakeScheduleHost({
      page,
      port: fakePort,
      serverId: fakeHost.serverId,
      workspace: fakeHost.workspace,
      project: fakeHost,
      agentDirectory: "empty",
    });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await addFakeScheduleHostAndReload({
      page,
      serverId: fakeHost.serverId,
      label: "Fake host",
      port: fakePort,
    });
    await page.goto(buildSchedulesRoute());
    await page.setViewportSize(MOBILE_SHEET_VIEWPORT);
    await openNewScheduleSheet(page);
    await page.getByTestId("schedule-host-trigger").click();
    await page.getByTestId(`schedule-host-option-${fakeHost.serverId}`).click();
    await chooseHeartbeatTarget(page);

    await page.getByTestId("schedule-agent-trigger").click();
    await expect(page.getByText("No agents on this host")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("schedule-form-submit")).toBeDisabled();
  });

  test("reads as loading while a host has not answered its agent directory", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "schedule-agent-hold-", git: false });
    cleanupTasks.push(() => workspace.cleanup());
    const fakeHost = await buildFakeScheduleHostWorkspace(workspace);
    const fakePort = String(59_000 + Math.floor(Math.random() * 900));

    await installFakeScheduleHost({
      page,
      port: fakePort,
      serverId: fakeHost.serverId,
      workspace: fakeHost.workspace,
      project: fakeHost,
      agentDirectory: "hold",
    });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await addFakeScheduleHostAndReload({
      page,
      serverId: fakeHost.serverId,
      label: "Fake host",
      port: fakePort,
    });
    await page.goto(buildSchedulesRoute());
    await page.setViewportSize(MOBILE_SHEET_VIEWPORT);
    await openNewScheduleSheet(page);
    await page.getByTestId("schedule-host-trigger").click();
    await page.getByTestId(`schedule-host-option-${fakeHost.serverId}`).click();
    await chooseHeartbeatTarget(page);

    await page.getByTestId("schedule-agent-trigger").click();
    // A host that never answers must not be reported as having no agents.
    await expect(page.getByText("No agents on this host")).toHaveCount(0);
    await expect(page.getByTestId("schedule-form-submit")).toBeDisabled();
  });

  test("opens the create form on the agent chosen from its tab menu", async ({ page }) => {
    const agentTitle = `Tab menu target ${Date.now()}`;
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "schedule-agent-entry-",
      title: agentTitle,
    });
    cleanupTasks.push(() => agent.cleanup());

    await page.goto(buildHostAgentDetailRoute(getServerId(), agent.agentId, agent.workspaceId));
    await page.waitForURL(
      (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
      { timeout: 60_000 },
    );
    await waitForWorkspaceTabsVisible(page);

    const tab = page.getByTestId(`workspace-tab-agent_${agent.agentId}`).first();
    await expect(tab).toBeVisible({ timeout: 30_000 });
    await tab.click({ button: "right" });

    const scheduleItem = page.getByTestId(
      `workspace-tab-context-agent_${agent.agentId}-schedule-message`,
    );
    await expect(scheduleItem).toBeVisible({ timeout: 30_000 });
    await scheduleItem.click();

    await expect(page).toHaveURL(new RegExp(`/schedules\\?.*agentId=${agent.agentId}`), {
      timeout: 30_000,
    });
    await expect(page.getByTestId("schedule-form-sheet")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("schedule-agent-trigger")).toContainText(agentTitle, {
      timeout: 30_000,
    });
  });
});
