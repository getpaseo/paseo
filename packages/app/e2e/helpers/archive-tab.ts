import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, type Page } from "@playwright/test";
import { buildCreateAgentPreferences, buildSeededHost } from "./daemon-registry";
import { waitForWorkspaceTabsVisible } from "./workspace-tabs";
import { buildHostAgentDetailRoute, buildHostSessionsRoute, buildHostWorkspaceRoute } from "@/utils/host-routes";

export type ArchiveTabAgent = {
  id: string;
  title: string;
  cwd: string;
};

type ArchiveTabDaemonClient = {
  connect(): Promise<void>;
  close(): Promise<void>;
  createAgent(options: {
    provider: string;
    model: string;
    thinkingOptionId: string;
    modeId: string;
    cwd: string;
    title: string;
    initialPrompt: string;
  }): Promise<{ id: string }>;
  archiveAgent(agentId: string): Promise<{ archivedAt: string }>;
  waitForFinish(agentId: string, timeout?: number): Promise<{ status: string }>;
};

function getDaemonPort(): string {
  const daemonPort = process.env.E2E_DAEMON_PORT;
  if (!daemonPort) {
    throw new Error("E2E_DAEMON_PORT is not set.");
  }
  if (daemonPort === "6767") {
    throw new Error("E2E_DAEMON_PORT must not point at the developer daemon.");
  }
  return daemonPort;
}

function getServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set.");
  }
  return serverId;
}

function getDaemonWsUrl(): string {
  return `ws://127.0.0.1:${getDaemonPort()}/ws`;
}

function buildSeededStoragePayload() {
  const nowIso = new Date().toISOString();
  return {
    daemon: buildSeededHost({
      serverId: getServerId(),
      endpoint: `127.0.0.1:${getDaemonPort()}`,
      nowIso,
    }),
    preferences: buildCreateAgentPreferences(getServerId()),
  };
}

async function loadDaemonClientConstructor(): Promise<
  new (config: {
    url: string;
    clientId: string;
    clientType: "cli";
  }) => ArchiveTabDaemonClient
> {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, "packages/server/dist/server/server/exports.js"),
  ).href;
  const mod = (await import(moduleUrl)) as {
    DaemonClient: new (config: {
      url: string;
      clientId: string;
      clientType: "cli";
    }) => ArchiveTabDaemonClient;
  };
  return mod.DaemonClient;
}

export async function connectArchiveTabDaemonClient(): Promise<ArchiveTabDaemonClient> {
  const DaemonClient = await loadDaemonClientConstructor();
  const client = new DaemonClient({
    url: getDaemonWsUrl(),
    clientId: `app-e2e-archive-tab-${randomUUID()}`,
    clientType: "cli",
  });
  await client.connect();
  return client;
}

export async function createIdleAgent(
  client: ArchiveTabDaemonClient,
  input: { cwd: string; title: string },
): Promise<ArchiveTabAgent> {
  const created = await client.createAgent({
    provider: "codex",
    model: "gpt-5.1-codex-mini",
    thinkingOptionId: "low",
    modeId: "full-access",
    cwd: input.cwd,
    title: input.title,
    initialPrompt: "Reply with exactly READY.",
  });
  const finished = await client.waitForFinish(created.id, 120_000);
  if (finished.status !== "idle") {
    throw new Error(`Expected agent ${created.id} to become idle, got ${finished.status}.`);
  }
  return {
    id: created.id,
    title: input.title,
    cwd: input.cwd,
  };
}

export async function archiveAgentFromDaemon(
  client: ArchiveTabDaemonClient,
  agentId: string,
): Promise<void> {
  await client.archiveAgent(agentId);
}

export async function primeAdditionalPage(page: Page): Promise<void> {
  const seedNonce = randomUUID();
  const { daemon, preferences } = buildSeededStoragePayload();

  await page.route(/:(6767)\b/, (route) => route.abort());
  await page.routeWebSocket(/:(6767)\b/, async (ws) => {
    await ws.close({ code: 1008, reason: "Blocked connection to localhost:6767 during e2e." });
  });
  await page.addInitScript(
    ({ daemon, preferences, seedNonce }) => {
      const disableOnceKey = "@paseo:e2e-disable-default-seed-once";
      const disableValue = localStorage.getItem(disableOnceKey);
      if (disableValue) {
        localStorage.removeItem(disableOnceKey);
        if (disableValue === seedNonce) {
          return;
        }
      }

      localStorage.setItem("@paseo:e2e", "1");
      localStorage.setItem("@paseo:e2e-seed-nonce", seedNonce);
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([daemon]));
      localStorage.removeItem("@paseo:settings");
      localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(preferences));
    },
    { daemon, preferences, seedNonce },
  );
  await page.goto("/");
}

export async function resetSeededPageState(page: Page): Promise<void> {
  const { daemon, preferences } = buildSeededStoragePayload();
  await page.goto("/");
  await page.evaluate(
    ({ daemon, preferences }) => {
      localStorage.clear();
      localStorage.setItem("@paseo:e2e", "1");
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([daemon]));
      localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(preferences));
      localStorage.removeItem("@paseo:settings");
    },
    { daemon, preferences },
  );
  await page.goto("/");
}

export async function openWorkspaceWithAgents(
  page: Page,
  agents: [ArchiveTabAgent, ArchiveTabAgent],
): Promise<void> {
  const serverId = getServerId();
  for (const agent of agents) {
    await page.goto(buildHostAgentDetailRoute(serverId, agent.id, agent.cwd));
    await waitForWorkspaceTabsVisible(page);
    await expectWorkspaceTabVisible(page, agent.id);
  }
}

export async function expectWorkspaceTabVisible(page: Page, agentId: string): Promise<void> {
  await expect(page.getByTestId(`workspace-tab-agent_${agentId}`).first()).toBeVisible({
    timeout: 30_000,
  });
}

export async function expectWorkspaceTabHidden(page: Page, agentId: string): Promise<void> {
  await expect(page.getByTestId(`workspace-tab-agent_${agentId}`)).toHaveCount(0, {
    timeout: 30_000,
  });
}

export async function expectWorkspaceArchiveOutcome(
  page: Page,
  input: { archivedAgentId: string; survivingAgentId: string },
): Promise<void> {
  await expectWorkspaceTabHidden(page, input.archivedAgentId);
  await expectWorkspaceTabVisible(page, input.survivingAgentId);
}

export async function reloadWorkspace(page: Page, workspaceId: string): Promise<void> {
  const serverId = getServerId();
  await page.goto(buildHostWorkspaceRoute(serverId, workspaceId));
  await waitForWorkspaceTabsVisible(page);
}

export async function openSessions(page: Page): Promise<void> {
  const sessionsButton = page.getByTestId("sidebar-sessions");
  await expect(sessionsButton).toBeVisible({ timeout: 30_000 });
  await sessionsButton.click();
  await expect(page).toHaveURL(new RegExp(`${buildHostSessionsRoute(getServerId())}$`), {
    timeout: 30_000,
  });
  await expect(page.getByText("Sessions", { exact: true }).last()).toBeVisible({
    timeout: 30_000,
  });
}

function getSessionRowByTitle(page: Page, title: string) {
  return page.locator('[data-testid^="agent-row-"]').filter({ hasText: title }).first();
}

export async function expectSessionRowVisible(page: Page, title: string): Promise<void> {
  await expect(getSessionRowByTitle(page, title)).toBeVisible({ timeout: 30_000 });
}

export async function expectSessionRowArchived(page: Page, title: string): Promise<void> {
  await expect(getSessionRowByTitle(page, title)).toContainText("Archived", { timeout: 30_000 });
}

export async function archiveAgentFromSessions(
  page: Page,
  input: { agentId: string; title: string },
): Promise<void> {
  const row = getSessionRowByTitle(page, input.title);
  await expect(row).toBeVisible({ timeout: 30_000 });
  const box = await row.boundingBox();
  if (!box) {
    throw new Error(`Could not read bounding box for session row ${input.agentId}.`);
  }

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(900);
  await page.mouse.up();

  const archiveButton = page.getByTestId("agent-action-archive").first();
  await expect(archiveButton).toBeVisible({ timeout: 10_000 });
  await archiveButton.click();
  await expectSessionRowArchived(page, input.title);
}
