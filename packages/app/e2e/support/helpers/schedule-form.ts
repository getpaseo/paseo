import { expect, type Page, type TestInfo } from "@playwright/test";
import { buildHostAgentDetailRoute, buildSchedulesRoute } from "@/utils/host-routes";
import { gotoAppShell } from "./app";
import { fakeHostPort } from "./daemon-port";
import {
  addFakeScheduleHostAndReload,
  buildFakeScheduleHostWorkspace,
  installFakeScheduleHost,
  type FakeScheduleHostWorkspace,
} from "./schedule-fake-host";
import { type SeededWorkspace } from "./seed-client";
import { getServerId } from "./server-id";
import { waitForWorkspaceTabsVisible } from "./workspace-tabs";
import { expectStableHeight } from "./settled";
import { waitForSidebarHydration } from "./workspace-ui";

const PHONE_VIEWPORT = { width: 390, height: 844 };

export interface ScheduleRecord {
  id: string;
  name: string | null;
  prompt: string;
  maxRuns: number | null;
  cadence?: { type: "cron"; expression: string };
  target: { type: string; agentId?: string };
}

/** The slice of the seeded daemon client these specs assert against. */
export interface ScheduleReadbackClient {
  scheduleList(): Promise<{ schedules: ScheduleRecord[]; error: string | null }>;
  scheduleDelete(input: { id: string }): Promise<{ error: string | null }>;
}

/** Opens the Schedules screen at phone width, where the form is a bottom sheet. */
export async function openSchedulesOnPhone(page: Page): Promise<void> {
  await gotoAppShell(page);
  await waitForSidebarHydration(page);
  await page.goto(buildSchedulesRoute());
  await page.setViewportSize(PHONE_VIEWPORT);
}

export async function openNewScheduleForm(page: Page): Promise<void> {
  await page.getByTestId("schedules-empty-new").click();
  const sheet = page.getByTestId("schedule-form-sheet");
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  await expectStableHeight(sheet);
}

export async function chooseHeartbeatType(page: Page): Promise<void> {
  await page.getByTestId("schedule-target-kind-agent").click();
  await expect(page.getByTestId("schedule-agent-trigger")).toBeVisible({ timeout: 30_000 });
}

export async function chooseScheduleHost(page: Page, serverId: string): Promise<void> {
  await page.getByTestId("schedule-host-trigger").click();
  await page.getByTestId(`schedule-host-option-${serverId}`).click();
}

export async function openAgentPicker(page: Page): Promise<void> {
  await page.getByTestId("schedule-agent-trigger").click();
}

export async function chooseHeartbeatAgent(page: Page, agentId: string): Promise<void> {
  await openAgentPicker(page);
  await page.getByTestId(`schedule-agent-option-${agentId}`).click();
}

export async function fillHeartbeatDetails(
  page: Page,
  details: { name: string; prompt: string; maxRuns?: string },
): Promise<void> {
  await page.getByTestId("schedule-name-input").fill(details.name);
  await page.getByTestId("schedule-prompt-input").fill(details.prompt);
  if (details.maxRuns !== undefined) {
    await page.getByTestId("schedule-max-runs-input").fill(details.maxRuns);
  }
}

export async function submitScheduleForm(page: Page): Promise<void> {
  await page.getByTestId("schedule-form-submit").click();
  await expect(page.getByTestId("schedule-form-sheet")).toHaveCount(0, { timeout: 30_000 });
}

/** A heartbeat reuses the agent it targets, so the new-agent configuration is gone. */
export async function expectNewAgentFieldsHidden(page: Page): Promise<void> {
  await expect(page.getByTestId("schedule-project-trigger")).toHaveCount(0);
  await expect(page.getByTestId("schedule-model-trigger")).toHaveCount(0);
  await expect(page.getByTestId("schedule-isolation-trigger")).toHaveCount(0);
}

export async function expectHostHasNoAgents(page: Page): Promise<void> {
  await expect(page.getByText("No agent sessions on this host")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("schedule-form-submit")).toBeDisabled();
}

/** A host that never answers must read as unresolved, never as "no agents". */
export async function expectAgentDirectoryUnresolved(page: Page): Promise<void> {
  await expect(page.getByText("No agent sessions on this host")).toHaveCount(0);
  await expect(page.getByTestId("schedule-form-submit")).toBeDisabled();
}

export async function expectSelectedAgent(page: Page, title: string): Promise<void> {
  await expect(page.getByTestId("schedule-agent-trigger")).toContainText(title, {
    timeout: 30_000,
  });
}

/**
 * Adds a host whose agent directory answers the way the test needs — with
 * nothing, or never at all — and leaves the app connected to it.
 */
export async function addHostWithAgentDirectory(input: {
  page: Page;
  testInfo: TestInfo;
  workspace: SeededWorkspace;
  agentDirectory: "empty" | "hold";
  slot: number;
}): Promise<FakeScheduleHostWorkspace> {
  const fakeHost = await buildFakeScheduleHostWorkspace(input.workspace);
  const port = fakeHostPort({ parallelIndex: input.testInfo.parallelIndex, slot: input.slot });
  await installFakeScheduleHost({
    page: input.page,
    port,
    serverId: fakeHost.serverId,
    workspace: fakeHost.workspace,
    project: fakeHost,
    agentDirectory: input.agentDirectory,
  });
  await gotoAppShell(input.page);
  await waitForSidebarHydration(input.page);
  await addFakeScheduleHostAndReload({
    page: input.page,
    serverId: fakeHost.serverId,
    label: "Fake host",
    port,
  });
  await input.page.goto(buildSchedulesRoute());
  await input.page.setViewportSize(PHONE_VIEWPORT);
  return fakeHost;
}

/** Asserts what the daemon actually stored, not what the UI claimed. */
export async function expectStoredSchedule(
  client: ScheduleReadbackClient,
  name: string,
  expected: Partial<ScheduleRecord>,
): Promise<void> {
  await expect(async () => {
    const list = await client.scheduleList();
    const schedule = list.schedules.find((candidate) => candidate.name === name);
    expect(schedule, `Expected a schedule named ${name}`).toBeDefined();
    expect(schedule).toMatchObject(expected);
  }).toPass({ timeout: 30_000 });
}

/**
 * Undo work a spec queued while it ran. Tasks run newest-first, every one of
 * them runs even after an earlier failure, and the failures surface together —
 * a daemon that cannot clean up leaves state the next spec inherits.
 */
export interface ScheduleCleanupQueue {
  add(task: () => Promise<void>): void;
  runAll(): Promise<void>;
}

export function createScheduleCleanupQueue(): ScheduleCleanupQueue {
  const tasks: Array<() => Promise<void>> = [];
  return {
    add(task) {
      tasks.push(task);
    },
    async runAll() {
      const pending = tasks.toReversed();
      tasks.length = 0;
      const failures: unknown[] = [];
      for (const task of pending) {
        try {
          await task();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Schedule cleanup failed");
      }
    },
  };
}

/**
 * Cleanup failures surface. A daemon that cannot list or delete leaves the
 * schedule behind, and the next spec inherits it.
 */
export async function deleteScheduleByName(
  client: ScheduleReadbackClient,
  name: string,
): Promise<void> {
  const list = await client.scheduleList();
  const schedule = list.schedules.find((candidate) => candidate.name === name);
  if (schedule) {
    await client.scheduleDelete({ id: schedule.id });
  }
}

/** Opens a seeded agent in its workspace and waits for the tab bar. */
export async function openAgentWorkspace(
  page: Page,
  agent: { agentId: string; workspaceId: string },
): Promise<void> {
  await page.goto(buildHostAgentDetailRoute(getServerId(), agent.agentId, agent.workspaceId));
  await page.waitForURL(
    (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
    { timeout: 60_000 },
  );
  await waitForWorkspaceTabsVisible(page);
}

/** Right-clicks an agent tab and picks "Schedule a message...". */
export async function scheduleMessageFromAgentTab(page: Page, agentId: string): Promise<void> {
  const tab = page.getByTestId(`workspace-tab-agent_${agentId}`).first();
  await expect(tab).toBeVisible({ timeout: 30_000 });
  await tab.click({ button: "right" });
  const entry = page.getByTestId(`workspace-tab-context-agent_${agentId}-schedule-message`);
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.click();
}

export async function expectPrefilledHeartbeatRoute(page: Page, agentId: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`/schedules\\?.*agentId=${agentId}`), {
    timeout: 30_000,
  });
  await expect(page.getByTestId("schedule-form-sheet")).toBeVisible({ timeout: 30_000 });
}
