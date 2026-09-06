import { test } from "../support/fixtures";
import { seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  addHostWithAgentDirectory,
  chooseHeartbeatAgent,
  chooseHeartbeatType,
  chooseScheduleHost,
  createScheduleCleanupQueue,
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
  const cleanup = createScheduleCleanupQueue();

  test.afterEach(() => cleanup.runAll());

  test("creates a heartbeat aimed at a running agent", async ({ page }) => {
    const name = `Heartbeat ${Date.now()}`;
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "schedule-agent-target-",
      title: `Heartbeat target ${Date.now()}`,
    });
    const client = agent.client as unknown as ScheduleReadbackClient;
    cleanup.add(() => agent.cleanup());
    cleanup.add(() => deleteScheduleByName(client, name));

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
    cleanup.add(() => workspace.cleanup());

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
    cleanup.add(() => workspace.cleanup());

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
    cleanup.add(() => agent.cleanup());

    await openAgentWorkspace(page, agent);
    await scheduleMessageFromAgentTab(page, agent.agentId);

    await expectPrefilledHeartbeatRoute(page, agent.agentId);
    await expectSelectedAgent(page, title);
  });
});
