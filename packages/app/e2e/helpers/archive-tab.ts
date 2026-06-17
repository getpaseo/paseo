import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { buildCreateAgentPreferences, buildSeededHost } from "./daemon-registry";
import { getE2EDaemonPort } from "./daemon-port";
import { getServerId } from "./server-id";
import { waitForWorkspaceTabsVisible } from "./workspace-tabs";
import {
  buildHostAgentDetailRoute,
  buildHostSessionsRoute,
  buildHostWorkspaceRoute,
} from "@/utils/host-routes";

export interface ArchiveTabAgent {
  id: string;
  title: string;
  cwd: string;
  workspaceId: string;
}

function buildSeededStoragePayload() {
  const nowIso = new Date().toISOString();
  return {
    daemon: buildSeededHost({
      serverId: getServerId(),
      endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
      nowIso,
    }),
    preferences: buildCreateAgentPreferences(getServerId()),
  };
}

/**
 * The slice of a daemon client `createIdleAgent` needs: spawn an agent and await
 * its idle upsert. The shared seed client satisfies it, so a spec can seed an
 * idle agent from the same client it uses for everything else.
 */
export interface IdleAgentSeedClient {
  openProject(cwd: string): Promise<{
    workspace: { id: string } | null;
    error: string | null;
  }>;
  createAgent(options: {
    provider: string;
    model: string;
    modeId: string;
    cwd: string;
    workspaceId: string;
    title: string;
  }): Promise<{ id: string }>;
  waitForAgentUpsert(
    agentId: string,
    predicate: (snapshot: { status: string }) => boolean,
    timeout?: number,
  ): Promise<{ status: string }>;
}

export async function createIdleAgent(
  client: IdleAgentSeedClient,
  input: { cwd: string; title: string },
): Promise<ArchiveTabAgent> {
  const opened = await client.openProject(input.cwd);
  if (!opened.workspace) {
    throw new Error(opened.error ?? `Failed to open project ${input.cwd}`);
  }
  const created = await client.createAgent({
    provider: "opencode",
    model: "opencode/gpt-5-nano",
    modeId: "bypassPermissions",
    cwd: input.cwd,
    workspaceId: opened.workspace.id,
    title: input.title,
  });
  const snapshot = await client.waitForAgentUpsert(
    created.id,
    (agent) => agent.status === "idle",
    30_000,
  );
  if (snapshot.status !== "idle") {
    throw new Error(`Expected agent ${created.id} to become idle, got ${snapshot.status}.`);
  }
  return {
    id: created.id,
    title: input.title,
    cwd: input.cwd,
    workspaceId: opened.workspace.id,
  };
}

export async function archiveAgentFromDaemon(
  client: { archiveAgent(agentId: string): Promise<{ archivedAt: string }> },
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
    ({ daemon: seededDaemon, preferences: seededPreferences, seedNonce: nonce }) => {
      const disableOnceKey = "@paseo:e2e-disable-default-seed-once";
      const disableValue = localStorage.getItem(disableOnceKey);
      if (disableValue) {
        localStorage.removeItem(disableOnceKey);
        if (disableValue === nonce) {
          return;
        }
      }

      localStorage.setItem("@paseo:e2e", "1");
      localStorage.setItem("@paseo:e2e-seed-nonce", nonce);
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seededDaemon]));
      localStorage.removeItem("@paseo:settings");
      localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(seededPreferences));
    },
    { daemon, preferences, seedNonce },
  );
  await page.goto("/");
}

export async function resetSeededPageState(page: Page): Promise<void> {
  const { daemon, preferences } = buildSeededStoragePayload();
  await page.goto("/");
  await page.evaluate(
    ({ daemon: seededDaemon, preferences: seededPreferences }) => {
      localStorage.clear();
      localStorage.setItem("@paseo:e2e", "1");
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seededDaemon]));
      localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(seededPreferences));
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
    await page.goto(buildHostAgentDetailRoute(serverId, agent.id, agent.workspaceId));

    // The workspace layout consumes `?open=agent:xxx`, returns null during the effect,
    // then replaces the URL with the clean workspace route after preparing the tab.
    // On CI, Expo Router's rootNavigationState may take time to initialize,
    // so we allow a generous timeout here (matching terminal-perf pattern).
    await page.waitForURL(
      (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
      { timeout: 60_000 },
    );

    await waitForWorkspaceTabsVisible(page);
    await expectWorkspaceTabVisible(page, agent.id);
  }
}

export async function expectWorkspaceTabVisible(page: Page, agentId: string): Promise<void> {
  await expect(
    page.getByTestId(`workspace-tab-agent_${agentId}`).filter({ visible: true }).first(),
  ).toBeVisible({ timeout: 30_000 });
}

export async function expectWorkspaceTabHidden(page: Page, agentId: string): Promise<void> {
  await expect(
    page.getByTestId(`workspace-tab-agent_${agentId}`).filter({ visible: true }),
  ).toHaveCount(0, {
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

export async function closeWorkspaceAgentTab(page: Page, agentId: string): Promise<void> {
  const closeButton = page.getByTestId(`workspace-agent-close-${agentId}`).filter({
    visible: true,
  });
  await expect(closeButton.first()).toBeVisible({ timeout: 30_000 });
  await closeButton.first().click();
  await expectWorkspaceTabHidden(page, agentId);
}

export async function expectArchivedAgentFocused(page: Page, agentId: string): Promise<void> {
  await expectWorkspaceTabVisible(page, agentId);
  await expect(
    page.getByText("This agent is archived").filter({ visible: true }).first(),
  ).toBeVisible({
    timeout: 30_000,
  });
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
  await expect(page.getByText("Agent history", { exact: true }).last()).toBeVisible({
    timeout: 30_000,
  });
}

const AGENT_ROW_SELECTOR = '[data-testid^="agent-row-"]';

function getSessionRowByTitle(page: Page, title: string) {
  return page.locator(AGENT_ROW_SELECTOR).filter({ hasText: title }).first();
}

export async function expectSessionRowVisible(page: Page, title: string): Promise<void> {
  await expect(getSessionRowByTitle(page, title)).toBeVisible({ timeout: 30_000 });
}

export async function expectSessionRowArchived(page: Page, title: string): Promise<void> {
  await expect(getSessionRowByTitle(page, title)).toContainText("Archived", { timeout: 30_000 });
}

export async function clickSessionRow(page: Page, title: string): Promise<void> {
  const row = getSessionRowByTitle(page, title);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
}

export async function expectSessionsEmptyState(page: Page): Promise<void> {
  // Guard: if session rows appear, a prior spec polluted the shared daemon — see 00-sessions-empty.spec.ts.
  await expect(page.locator(AGENT_ROW_SELECTOR)).toHaveCount(0, { timeout: 5_000 });
  await expect(page.getByText("No sessions yet")).toBeVisible({ timeout: 30_000 });
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

  // Long-press the row. Idle agents are archived immediately (no modal).
  // Running/initializing agents show a confirmation modal instead.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(900);
  await page.mouse.up();

  // If a confirmation modal appears (running agent), click the archive button.
  const archiveButton = page.getByTestId("agent-action-archive").first();
  const modalVisible = await archiveButton.isVisible().catch(() => false);
  if (modalVisible) {
    await archiveButton.click();
  }

  await expectSessionRowArchived(page, input.title);
}
