import { realpathSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { expect, type Page } from "@playwright/test";
import { parseHostWorkspaceRouteFromPathname } from "../../src/utils/host-routes";
import { gotoAppShell } from "./app";
import { createNodeWebSocketFactory, type NodeWebSocketFactory } from "./node-ws-factory";
import { switchWorkspaceViaSidebar } from "./workspace-ui";
import type { SessionOutboundMessage } from "@server/shared/messages";

interface WorkspaceSetupDaemonClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  openProject(cwd: string): Promise<{
    workspace: {
      id: string;
      name: string;
      workspaceDirectory: string;
      projectRootPath: string;
    } | null;
    error: string | null;
  }>;
  createPaseoWorktree(input: { cwd: string; worktreeSlug?: string }): Promise<{
    workspace: {
      id: string;
      name: string;
      workspaceDirectory: string;
      projectRootPath: string;
    } | null;
    error: string | null;
  }>;
  fetchWorkspaces(): Promise<{
    entries: Array<{
      id: string;
      name: string;
      workspaceDirectory: string;
      projectRootPath: string;
    }>;
  }>;
  fetchAgents(): Promise<{
    entries: Array<{
      agent: { id: string; cwd: string; workspaceId?: string | null };
    }>;
  }>;
  fetchAgent(agentId: string): Promise<{
    agent: { id: string; cwd: string } | null;
    project: unknown | null;
  } | null>;
  listTerminals(cwd: string): Promise<{
    cwd?: string;
    terminals: Array<{ id: string; cwd: string; name: string }>;
    error?: string | null;
  }>;
  subscribeRawMessages(handler: (message: SessionOutboundMessage) => void): () => void;
}

export type WorkspaceSetupProgressPayload = Extract<
  SessionOutboundMessage,
  { type: "workspace_setup_progress" }
>["payload"];

export type { WorkspaceSetupDaemonClient };

function getDaemonWsUrl(): string {
  const daemonPort = process.env.E2E_DAEMON_PORT;
  if (!daemonPort) {
    throw new Error("E2E_DAEMON_PORT is not set.");
  }
  return `ws://127.0.0.1:${daemonPort}/ws`;
}

async function loadDaemonClientConstructor(): Promise<
  new (config: {
    url: string;
    clientId: string;
    clientType: "cli";
    webSocketFactory?: NodeWebSocketFactory;
  }) => WorkspaceSetupDaemonClient
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
      webSocketFactory?: NodeWebSocketFactory;
    }) => WorkspaceSetupDaemonClient;
  };
  return mod.DaemonClient;
}

export async function connectWorkspaceSetupClient(): Promise<WorkspaceSetupDaemonClient> {
  const DaemonClient = await loadDaemonClientConstructor();
  const webSocketFactory = createNodeWebSocketFactory();
  const client = new DaemonClient({
    url: getDaemonWsUrl(),
    clientId: `workspace-setup-${randomUUID()}`,
    clientType: "cli",
    webSocketFactory,
  });
  await client.connect();
  return client;
}

export async function seedProjectForWorkspaceSetup(
  client: WorkspaceSetupDaemonClient,
  repoPath: string,
): Promise<void> {
  const result = await client.openProject(repoPath);
  if (!result.workspace || result.error) {
    throw new Error(result.error ?? `Failed to open project ${repoPath}`);
  }
}

export function projectNameFromPath(repoPath: string): string {
  return repoPath.replace(/\/+$/, "").split("/").findLast(Boolean) ?? repoPath;
}

export async function openHomeWithProject(page: Page, repoPath: string): Promise<void> {
  await gotoAppShell(page);
  await expect(
    page
      .locator('[data-testid^="sidebar-project-row-"]')
      .filter({ hasText: projectNameFromPath(repoPath) })
      .first(),
  ).toBeVisible({ timeout: 30_000 });
}

function createWorkspaceButton(page: Page, repoPath: string) {
  return page.getByRole("button", {
    name: `Create a new workspace for ${projectNameFromPath(repoPath)}`,
  });
}

async function revealWorkspaceButton(page: Page, repoPath: string): Promise<void> {
  await page
    .locator('[data-testid^="sidebar-project-row-"]')
    .filter({ hasText: projectNameFromPath(repoPath) })
    .first()
    .hover();
}

export async function createWorkspaceFromSidebar(page: Page, repoPath: string): Promise<void> {
  const button = createWorkspaceButton(page, repoPath);
  await revealWorkspaceButton(page, repoPath);
  await expect(button).toBeVisible({ timeout: 30_000 });
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await button.click();
  await expect(page).toHaveURL(/\/new\?/, { timeout: 30_000 });
  await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toBeVisible({
    timeout: 30_000,
  });
}

export async function getCurrentWorkspaceIdFromRoute(page: Page): Promise<string> {
  await expect
    .poll(
      () => parseHostWorkspaceRouteFromPathname(new URL(page.url()).pathname)?.workspaceId ?? null,
      { timeout: 30_000 },
    )
    .not.toBeNull();

  const workspaceId =
    parseHostWorkspaceRouteFromPathname(new URL(page.url()).pathname)?.workspaceId ?? null;
  if (!workspaceId) {
    throw new Error(`Expected a workspace route but found ${page.url()}`);
  }

  return workspaceId;
}

function workspaceSetupDialog(page: Page) {
  return page.getByTestId("workspace-setup-dialog");
}

export async function createChatAgentFromWorkspaceSetup(
  page: Page,
  input: { message: string },
): Promise<void> {
  const messageInput = page.getByRole("textbox", { name: "Message agent..." }).first();
  await expect(messageInput).toBeVisible({ timeout: 15_000 });
  await messageInput.fill(input.message);
  await messageInput.press("Enter");
}

/**
 * @deprecated The new workspace screen no longer has a standalone terminal button.
 * Use the daemon API to create a workspace, then open a terminal from the launcher.
 */
export async function createStandaloneTerminalFromWorkspaceSetup(page: Page): Promise<void> {
  await workspaceSetupDialog(page)
    .getByRole("button", { name: /^Terminal Create the workspace/i })
    .click();
}

export async function waitForWorkspaceSetupDialogToClose(
  page: Page,
  timeoutMs = 45_000,
): Promise<void> {
  const dialog = workspaceSetupDialog(page);

  try {
    await expect(dialog).toHaveCount(0, { timeout: timeoutMs });
  } catch (error) {
    const dialogText = (await dialog.textContent().catch(() => null))?.replace(/\s+/g, " ").trim();
    throw new Error(
      dialogText
        ? `Workspace setup dialog stayed open. Visible text: ${dialogText}`
        : `Workspace setup dialog did not close within ${timeoutMs}ms`,
      { cause: error },
    );
  }
}

export async function expectSetupPanel(page: Page): Promise<void> {
  // If the setup panel is already visible (auto-opened), we're done.
  const panel = page.getByTestId("workspace-setup-panel");
  if (await panel.isVisible().catch(() => false)) {
    return;
  }
  // Otherwise open it manually via workspace header actions menu.
  // Use the specific testID to avoid matching the sidebar kebab which shares
  // the same "Workspace actions" accessibility label.
  const actionsButton = page.getByTestId("workspace-header-menu-trigger");
  await expect(actionsButton).toBeVisible({ timeout: 10_000 });
  await actionsButton.click();
  const showSetup = page.getByTestId("workspace-header-show-setup");
  await expect(showSetup).toBeVisible({ timeout: 5_000 });
  await showSetup.click();
  await expect(panel).toBeVisible({ timeout: 30_000 });
}

export async function expectSetupStatus(
  page: Page,
  status: "Running" | "Completed" | "Failed",
): Promise<void> {
  await expect(page.getByTestId("workspace-setup-status")).toContainText(status, {
    timeout: 30_000,
  });
}

export async function expectSetupLogContains(page: Page, text: string): Promise<void> {
  await expect(page.getByTestId("workspace-setup-log")).toContainText(text, {
    timeout: 30_000,
  });
}

export async function expectNoSetupMessage(page: Page): Promise<void> {
  await expect(
    page.getByText("No setup commands ran for this workspace.", { exact: true }),
  ).toBeVisible({
    timeout: 30_000,
  });
}

export async function createWorkspaceThroughDaemon(
  client: WorkspaceSetupDaemonClient,
  input: { cwd: string; worktreeSlug: string },
): Promise<{ id: string; name: string }> {
  const result = await client.createPaseoWorktree(input);
  if (!result.workspace || result.error) {
    throw new Error(result.error ?? `Failed to create workspace for ${input.cwd}`);
  }
  return {
    id: result.workspace.id,
    name: result.workspace.name,
  };
}

export async function findWorktreeWorkspaceForProject(
  client: WorkspaceSetupDaemonClient,
  repoPath: string,
): Promise<{
  id: string;
  name: string;
  projectRootPath: string;
  workspaceDirectory: string;
}> {
  const payload = await client.fetchWorkspaces();
  const normalizedRepoPath = realpathSync(repoPath);
  const workspace =
    payload.entries.find(
      (entry) =>
        entry.projectRootPath === normalizedRepoPath &&
        entry.workspaceDirectory !== normalizedRepoPath,
    ) ?? null;
  if (!workspace) {
    throw new Error(`Failed to find created worktree workspace for ${repoPath}`);
  }
  return {
    id: workspace.id,
    name: workspace.name,
    projectRootPath: workspace.projectRootPath,
    workspaceDirectory: workspace.workspaceDirectory,
  };
}

export async function fetchWorkspaceById(
  client: WorkspaceSetupDaemonClient,
  workspaceId: string,
): Promise<{
  id: string;
  name: string;
  workspaceDirectory: string;
  projectRootPath: string;
}> {
  const payload = await client.fetchWorkspaces();
  const workspace = payload.entries.find((entry) => entry.id === workspaceId) ?? null;
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  return workspace;
}

export async function navigateToWorkspaceViaSidebar(
  page: Page,
  workspaceId: string,
): Promise<void> {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set.");
  }
  await switchWorkspaceViaSidebar({ page, serverId, targetWorkspacePath: workspaceId });
}

export async function openWorkspaceScriptsMenu(page: Page): Promise<void> {
  await page.getByTestId("workspace-scripts-button").click();
  await expect(page.getByTestId("workspace-scripts-menu")).toBeVisible({ timeout: 10_000 });
}

export async function startWorkspaceScriptFromMenu(page: Page, scriptName: string): Promise<void> {
  await page.getByTestId(`workspace-scripts-start-${scriptName}`).click();
}

export async function closeWorkspaceScriptsMenu(page: Page): Promise<void> {
  await page.getByTestId("workspace-scripts-menu-backdrop").click();
}

export async function waitForWorkspaceSetupProgress(
  client: WorkspaceSetupDaemonClient,
  predicate: (payload: WorkspaceSetupProgressPayload) => boolean,
  timeoutMs = 30_000,
): Promise<WorkspaceSetupProgressPayload> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for workspace_setup_progress after ${timeoutMs}ms`));
    }, timeoutMs);

    const unsubscribe = client.subscribeRawMessages((message) => {
      if (message.type !== "workspace_setup_progress") {
        return;
      }
      if (!predicate(message.payload)) {
        return;
      }
      clearTimeout(timeout);
      unsubscribe();
      resolve(message.payload);
    });
  });
}
