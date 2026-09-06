import { test } from "../support/fixtures";
import { seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  addHostWithAgentDirectory,
  chooseHeartbeatAgent,
  chooseHeartbeatType,
  chooseScheduleHost,
  deleteScheduleByName,
  expectAgentDirectoryUnresolved,
  expectHostHasNoAgents,
  expectNewAgentFieldsHidden,
  expectPrefilledHeartbeatRoute,
  expectSelectedAgent,
  expectStoredSchedule,
  fillHeartbeatDetails,
  openAgentPicker,
  openAgentWorkspace,
  openNewScheduleForm,
  openSchedulesOnPhone,
  scheduleMessageFromAgentTab,
  submitScheduleForm,
  type ScheduleReadbackClient,
} from "../support/helpers/schedule-form";

test.describe("Schedules targeting an existing agent", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  test.afterEach(async () => {
    const tasks = cleanupTasks.toReversed();
    cleanupTasks.length = 0;
    // Every task runs even if an earlier one fails, then the failures surface.
    const failures: unknown[] = [];
    for (const cleanup of tasks) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Schedule cleanup failed");
    }
  });

  test("creates a heartbeat aimed at a running agent", async ({ page }) => {
    const name = `Heartbeat ${Date.now()}`;
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "schedule-agent-target-",
      title: `Heartbeat target ${Date.now()}`,
    });
    const client = agent.client as unknown as ScheduleReadbackClient;
    cleanupTasks.push(() => agent.cleanup());
    cleanupTasks.push(() => deleteScheduleByName(client, name));

    await openSchedulesOnPhone(page);
    await openNewScheduleForm(page);
    await chooseHeartbeatType(page);
    await expectNewAgentFieldsHidden(page);
    await chooseHeartbeatAgent(page, agent.agentId);
    await fillHeartbeatDetails(page, {
      name,
      prompt: "Continue where you left off",
      maxRuns: "1",
    });
    await submitScheduleForm(page);

    await expectStoredSchedule(client, name, {
      prompt: "Continue where you left off",
      maxRuns: 1,
      target: { type: "agent", agentId: agent.agentId },
    });
  });

  test("reports a host that answered with no agents", async ({ page }, testInfo) => {
    const workspace = await seedWorkspace({ repoPrefix: "schedule-agent-empty-", git: false });
    cleanupTasks.push(() => workspace.cleanup());

    const host = await addHostWithAgentDirectory({
      page,
      testInfo,
      workspace,
      agentDirectory: "empty",
      slot: 0,
    });
    await openNewScheduleForm(page);
    await chooseScheduleHost(page, host.serverId);
    await chooseHeartbeatType(page);
    await openAgentPicker(page);

    await expectHostHasNoAgents(page);
  });

  test("reads as unresolved while a host has not answered its agent directory", async ({
    page,
  }, testInfo) => {
    const workspace = await seedWorkspace({ repoPrefix: "schedule-agent-hold-", git: false });
    cleanupTasks.push(() => workspace.cleanup());

    const host = await addHostWithAgentDirectory({
      page,
      testInfo,
      workspace,
      agentDirectory: "hold",
      slot: 1,
    });
    await openNewScheduleForm(page);
    await chooseScheduleHost(page, host.serverId);
    await chooseHeartbeatType(page);
    await openAgentPicker(page);

    await expectAgentDirectoryUnresolved(page);
  });

  test("opens the create form on the agent chosen from its tab menu", async ({ page }) => {
    const title = `Tab menu target ${Date.now()}`;
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "schedule-agent-entry-",
      title,
    });
    cleanupTasks.push(() => agent.cleanup());

    await openAgentWorkspace(page, agent);
    await scheduleMessageFromAgentTab(page, agent.agentId);

    await expectPrefilledHeartbeatRoute(page, agent.agentId);
    await expectSelectedAgent(page, title);
  });
});
