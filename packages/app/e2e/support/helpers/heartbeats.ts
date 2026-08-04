import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import { seedParentWithSubagent } from "./subagents";
import { seedWorkspace, type SeededWorkspace } from "./seed-client";

interface HeartbeatScheduleClient {
  scheduleCreate(input: {
    prompt: string;
    name: string;
    cadence: { type: "every"; everyMs: number };
    target: { type: "agent"; agentId: string };
    runOnCreate: false;
    expiresAt?: string;
  }): Promise<{ schedule: ScheduleSummary | null; error: string | null }>;
  scheduleDelete(input: { id: string }): Promise<{ error: string | null }>;
  scheduleList(): Promise<{ schedules: ScheduleSummary[]; error: string | null }>;
  scheduleUpdate(input: {
    id: string;
    expiresAt: string;
  }): Promise<{ schedule: ScheduleSummary | null; error: string | null }>;
}

export interface SeededHeartbeat {
  id: string;
  name: string;
  cadence: string;
}

export interface AgentHeartbeatScenario {
  workspace: SeededWorkspace;
  parent: { id: string; title: string };
  child: { id: string; title: string };
  createHeartbeat(input?: { name?: string; expiresAt?: string }): Promise<SeededHeartbeat>;
  setHeartbeatExpiry(id: string, expiresAt: string): Promise<void>;
  readWorkspaceStatus(): Promise<string | null>;
  readHeartbeatExists(id: string): Promise<boolean>;
  readAgentStatuses(): Promise<Record<string, string>>;
  cleanup(): Promise<void>;
}

export async function seedAgentWithHeartbeat(): Promise<AgentHeartbeatScenario> {
  const workspace = await seedWorkspace({
    repoPrefix: "agent-heartbeat-track-",
    title: "Heartbeat workspace",
  });
  const scheduleClient = workspace.client as unknown as HeartbeatScheduleClient;
  try {
    const agents = await seedParentWithSubagent(workspace, {
      parentTitle: "Build babysitter",
      childTitle: "Build observer",
    });
    await workspace.client.waitForAgentUpsert(
      agents.parent.id,
      (snapshot) => snapshot.status === "idle",
      30_000,
    );
    await workspace.client.waitForAgentUpsert(
      agents.child.id,
      (snapshot) => snapshot.status === "idle",
      30_000,
    );
    const heartbeatIds = new Set<string>();
    return {
      workspace,
      parent: agents.parent,
      child: agents.child,
      createHeartbeat: async (input = {}) => {
        const name = input.name ?? "Watch the build";
        const created = await scheduleClient.scheduleCreate({
          prompt: "Check the build and report any failures.",
          name,
          cadence: { type: "every", everyMs: 15 * 60_000 },
          target: { type: "agent", agentId: agents.parent.id },
          runOnCreate: false,
          ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        });
        if (!created.schedule) {
          throw new Error(created.error ?? "Failed to create heartbeat");
        }
        heartbeatIds.add(created.schedule.id);
        return { id: created.schedule.id, name, cadence: "Every 15 minutes" };
      },
      setHeartbeatExpiry: async (id, expiresAt) => {
        const updated = await scheduleClient.scheduleUpdate({ id, expiresAt });
        if (!updated.schedule) {
          throw new Error(updated.error ?? "Failed to update heartbeat expiry");
        }
      },
      readWorkspaceStatus: async () => {
        const result = await workspace.client.fetchWorkspaces();
        return (
          (
            result.entries.find((entry) => entry.id === workspace.workspaceId) as
              | ((typeof result.entries)[number] & { status?: string })
              | undefined
          )?.status ?? null
        );
      },
      readHeartbeatExists: async (id) => {
        const result = await scheduleClient.scheduleList();
        return result.schedules.some((schedule) => schedule.id === id);
      },
      readAgentStatuses: async () => {
        const result = await workspace.client.fetchAgents({ scope: "active" });
        return Object.fromEntries(result.entries.map(({ agent }) => [agent.id, agent.status]));
      },
      cleanup: async () => {
        await Promise.all(
          Array.from(heartbeatIds, (id) =>
            scheduleClient.scheduleDelete({ id }).catch(() => undefined),
          ),
        );
        await workspace.cleanup();
      },
    };
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}

export async function expectWorkspaceRunning(page: Page): Promise<void> {
  await expect(
    page
      .getByRole("button", { name: /^Heartbeat workspace(?:, Working)?$/ })
      .getByTestId("workspace-status-indicator-running"),
  ).toBeVisible({ timeout: 60_000 });
}

export async function expectWorkspaceDone(page: Page): Promise<void> {
  const workspaceRow = page.getByRole("button", {
    name: /^Heartbeat workspace(?:, Working)?$/,
  });
  await expect(workspaceRow.getByTestId("workspace-status-indicator-done")).toBeVisible({
    timeout: 60_000,
  });
  await expect(workspaceRow.getByTestId("workspace-status-indicator-running")).toHaveCount(0);
}

export async function openHeartbeatAndSubagentTracks(
  page: Page,
  heartbeat: SeededHeartbeat,
  subagentId: string,
): Promise<void> {
  await openHeartbeatTrack(page, heartbeat);
  await ensureTrackExpanded(
    page,
    "1 subagent",
    page.getByTestId(`subagents-track-row-${subagentId}`),
  );
}

export async function openHeartbeatTrack(page: Page, heartbeat: SeededHeartbeat): Promise<void> {
  await ensureTrackExpanded(
    page,
    "1 heartbeat",
    page.getByRole("link", { name: `${heartbeat.name}, ${heartbeat.cadence}` }),
  );
}

export async function expectHeartbeatVisible(
  page: Page,
  heartbeat: SeededHeartbeat,
): Promise<void> {
  await expect(
    page.getByRole("link", { name: `${heartbeat.name}, ${heartbeat.cadence}` }),
  ).toBeVisible({ timeout: 30_000 });
}

export async function openHeartbeat(page: Page, heartbeat: SeededHeartbeat): Promise<void> {
  await page.getByRole("link", { name: `${heartbeat.name}, ${heartbeat.cadence}` }).click();
}

export async function expectHeartbeatDetails(
  page: Page,
  heartbeat: SeededHeartbeat,
): Promise<void> {
  const sheet = page.getByTestId("schedule-form-sheet");
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  await expect(sheet.getByText("Edit heartbeat", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`scheduleId=${heartbeat.id}`));
  await expect(page.getByText("*/15 * * * *", { exact: true }).first()).toBeVisible();
}

export async function returnToAgentHeartbeat(page: Page): Promise<void> {
  await page.goBack();
  await expect(page.getByRole("button", { name: "1 heartbeat" })).toBeVisible({
    timeout: 30_000,
  });
}

export async function removeSeededSubagent(scenario: AgentHeartbeatScenario): Promise<void> {
  await scenario.workspace.client.archiveAgent(scenario.child.id);
}

export async function deleteHeartbeat(page: Page, heartbeat: SeededHeartbeat): Promise<void> {
  const row = page.getByRole("link", { name: `${heartbeat.name}, ${heartbeat.cadence}` });
  await row.hover();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: `Delete heartbeat ${heartbeat.name}` }).click();
  await expect(row).toHaveCount(0, { timeout: 30_000 });
}

export async function captureHeartbeatEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function ensureTrackExpanded(page: Page, name: string, content: Locator): Promise<void> {
  const disclosure = page.getByRole("button", { name });
  await expect(disclosure).toBeVisible({ timeout: 30_000 });
  if (!(await content.isVisible())) {
    await disclosure.click();
  }
  await expect(content).toBeVisible({ timeout: 30_000 });
}
