import { expect, test, type Page } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { buildSeededHost } from "./helpers/daemon-registry";
import { wsRoutePatternForPort } from "./helpers/daemon-port";
import { getServerId } from "./helpers/server-id";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";
import { waitForSidebarHydration } from "./helpers/workspace-ui";
import { buildSchedulesRoute } from "../src/utils/host-routes";

const REGISTRY_KEY = "@paseo:daemon-registry";
const SEED_NONCE_KEY = "@paseo:e2e-seed-nonce";
const DISABLE_DEFAULT_SEED_ONCE_KEY = "@paseo:e2e-disable-default-seed-once";
const FAKE_HOST_MODEL_ID = "fake-host-model";
const FAKE_HOST_MODEL_LABEL = "Fake host model";

interface ScheduleListItem {
  id: string;
  name: string | null;
  target: { type: string; config?: { cwd?: string } };
}

interface ScheduleSeedClient {
  scheduleList(): Promise<{ schedules: ScheduleListItem[]; error: string | null }>;
  scheduleDelete(input: { id: string }): Promise<{ error: string | null }>;
}

type WebSocketMessage = string | Buffer;
type SessionRequest = Record<string, unknown> & { type?: string; requestId?: string };

function parseJson(message: WebSocketMessage): unknown {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildSessionMessage(type: string, payload: Record<string, unknown>) {
  return JSON.stringify({
    type: "session",
    message: {
      type,
      payload,
    },
  });
}

function buildFakeProviderEntries(nowIso: string) {
  return [
    {
      provider: "mock",
      label: "Mock",
      status: "ready",
      enabled: true,
      fetchedAt: nowIso,
      models: [
        {
          provider: "mock",
          id: FAKE_HOST_MODEL_ID,
          label: FAKE_HOST_MODEL_LABEL,
          isDefault: true,
        },
      ],
      modes: [{ id: "load-test", label: "Load test" }],
      defaultModeId: "load-test",
    },
  ];
}

async function installFakeScheduleHost(input: {
  page: Page;
  port: string;
  serverId: string;
  workspace: Record<string, unknown>;
}): Promise<void> {
  await input.page.routeWebSocket(wsRoutePatternForPort(input.port), (ws) => {
    ws.onMessage((message) => {
      const parsed = parseJson(message);
      if (!parsed || typeof parsed !== "object") {
        return;
      }
      const envelope = parsed as { type?: string; message?: SessionRequest };
      const now = Date.now();
      const nowIso = new Date(now).toISOString();

      if (envelope.type === "hello") {
        ws.send(
          buildSessionMessage("status", {
            status: "server_info",
            serverId: input.serverId,
            hostname: "fake-schedule-host",
            version: "0.0.0-e2e",
            features: {
              providersSnapshot: true,
              workspaceMultiplicity: true,
              projectAdd: true,
              projectRemove: true,
              worktreeRestore: true,
            },
          }),
        );
        return;
      }

      if (envelope.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (envelope.type !== "session" || !envelope.message) {
        return;
      }

      const request = envelope.message;
      const requestId = typeof request.requestId === "string" ? request.requestId : "fake-request";
      switch (request.type) {
        case "ping":
          ws.send(
            buildSessionMessage("pong", {
              requestId,
              clientSentAt: typeof request.clientSentAt === "number" ? request.clientSentAt : now,
              serverReceivedAt: now,
              serverSentAt: now,
            }),
          );
          return;
        case "fetch_workspaces_request":
          ws.send(
            buildSessionMessage("fetch_workspaces_response", {
              requestId,
              entries: [input.workspace],
              emptyProjects: [],
              pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
            }),
          );
          return;
        case "fetch_agents_request":
          ws.send(
            buildSessionMessage("fetch_agents_response", {
              requestId,
              entries: [],
              pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
            }),
          );
          return;
        case "get_providers_snapshot_request":
          ws.send(
            buildSessionMessage("get_providers_snapshot_response", {
              requestId,
              entries: buildFakeProviderEntries(nowIso),
              generatedAt: nowIso,
            }),
          );
          return;
        case "refresh_providers_snapshot_request":
          ws.send(
            buildSessionMessage("refresh_providers_snapshot_response", {
              requestId,
              acknowledged: true,
            }),
          );
          return;
        case "schedule/list":
          ws.send(
            buildSessionMessage("schedule/list/response", {
              requestId,
              schedules: [],
              error: null,
            }),
          );
          return;
      }
    });
  });
}

async function addFakeHostAndReload(input: {
  page: Page;
  serverId: string;
  label: string;
  port: string;
}): Promise<void> {
  const host = buildSeededHost({
    serverId: input.serverId,
    label: input.label,
    endpoint: `127.0.0.1:${input.port}`,
    nowIso: new Date().toISOString(),
  });

  await input.page.evaluate(
    ({ seededHost, keys }) => {
      const nonce = localStorage.getItem(keys.nonce);
      if (!nonce) {
        throw new Error("Expected the e2e seed nonce before overriding the host registry.");
      }
      const raw = localStorage.getItem(keys.registry);
      const registry: Array<{ serverId: string }> = raw ? JSON.parse(raw) : [];
      localStorage.setItem(keys.registry, JSON.stringify([...registry, seededHost]));
      localStorage.setItem(keys.disableSeedOnce, nonce);
    },
    {
      seededHost: host,
      keys: {
        registry: REGISTRY_KEY,
        nonce: SEED_NONCE_KEY,
        disableSeedOnce: DISABLE_DEFAULT_SEED_ONCE_KEY,
      },
    },
  );

  await input.page.reload();
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
    const workspaceList = await workspace.client.fetchWorkspaces({
      filter: { projectId: workspace.projectId },
    });
    const workspaceTemplate = workspaceList.entries.find(
      (entry) => entry.id === workspace.workspaceId,
    );
    if (!workspaceTemplate) {
      throw new Error(`Failed to load seeded workspace descriptor ${workspace.workspaceId}`);
    }

    const fakeServerId = "schedule-fake-host";
    const fakeProjectId = `${workspace.projectId}-fake-host`;
    const fakeCwd = `${workspace.repoPath}-fake-host`;
    const fakeWorkspace = {
      ...workspaceTemplate,
      id: `${workspaceTemplate.id}-fake-host`,
      projectId: fakeProjectId,
      projectDisplayName: "Fake host project",
      projectRootPath: fakeCwd,
      workspaceDirectory: fakeCwd,
      name: "Fake host project",
      project: undefined,
    };
    const fakePort = String(59_000 + Math.floor(Math.random() * 900));

    await installFakeScheduleHost({
      page,
      port: fakePort,
      serverId: fakeServerId,
      workspace: fakeWorkspace,
    });

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await page.goto(buildSchedulesRoute());
    await addFakeHostAndReload({
      page,
      serverId: fakeServerId,
      label: "Fake host",
      port: fakePort,
    });
    await expect(page.getByTestId(`schedules-section-${fakeServerId}`)).toBeVisible({
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
    await page.getByTestId(`schedule-project-option-${fakeProjectId}`).click();
    await expect(page.getByRole("button", { name: /select project/i })).toContainText(
      "Fake host project",
    );
    await expect(page.getByRole("button", { name: /select model/i })).toBeVisible();

    await page.getByLabel("Schedule name").fill(`Cross host model ${Date.now()}`);
    await page.getByLabel("Prompt").fill("Run on the fake host project.");
    await expect(page.getByRole("button", { name: "Create schedule" })).toBeDisabled();
  });
});
