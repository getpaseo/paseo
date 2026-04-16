import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, type Page } from "@playwright/test";
import type { DaemonClient as ServerDaemonClient } from "@server/client/daemon-client";
import { decodeWorkspaceIdFromPathSegment } from "@/utils/host-routes";
import { expectWorkspaceHeader, workspaceLabelFromPath } from "./workspace-ui";
import { createNodeWebSocketFactory, type NodeWebSocketFactory } from "./node-ws-factory";

type NewWorkspaceDaemonClient = Pick<
  ServerDaemonClient,
  | "archivePaseoWorktree"
  | "archiveWorkspace"
  | "close"
  | "connect"
  | "createPaseoWorktree"
  | "openProject"
>;

type NewWorkspaceDaemonClientConfig = {
  url: string;
  clientId: string;
  clientType: "cli";
  webSocketFactory?: NodeWebSocketFactory;
};

type OpenProjectPayload = Awaited<ReturnType<NewWorkspaceDaemonClient["openProject"]>>;

export type OpenedProject = {
  workspaceId: string;
  projectKey: string;
  projectDisplayName: string;
  workspaceName: string;
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

function getDaemonWsUrl(): string {
  return `ws://127.0.0.1:${getDaemonPort()}/ws`;
}

async function loadDaemonClientConstructor(): Promise<
  new (
    config: NewWorkspaceDaemonClientConfig,
  ) => NewWorkspaceDaemonClient
> {
  const repoRoot = path.resolve(__dirname, "../../../../");
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, "packages/server/dist/server/server/exports.js"),
  ).href;
  const mod = (await import(moduleUrl)) as {
    DaemonClient: new (config: NewWorkspaceDaemonClientConfig) => NewWorkspaceDaemonClient;
  };
  return mod.DaemonClient;
}

function requireWorkspace(payload: OpenProjectPayload) {
  if (payload.error) {
    throw new Error(payload.error);
  }
  if (!payload.workspace) {
    throw new Error("openProject returned no workspace.");
  }
  return payload.workspace;
}

function parseWorkspaceIdFromPageUrl(page: Page, serverId: string): string | null {
  const pathname = new URL(page.url()).pathname;
  const match = pathname.match(
    new RegExp(`^/h/${serverId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/workspace/([^/?#]+)`),
  );
  if (!match?.[1]) {
    return null;
  }
  return decodeWorkspaceIdFromPathSegment(match[1]);
}

function parseWorkspaceIdFromSidebarRowTestId(
  testId: string,
  input: { serverId: string; previousWorkspaceId: string },
): string | null {
  const prefix = `sidebar-workspace-row-${input.serverId}:`;
  if (!testId.startsWith(prefix)) {
    return null;
  }
  const workspaceId = testId.slice(prefix.length).trim();
  if (!workspaceId || workspaceId === input.previousWorkspaceId) {
    return null;
  }
  return workspaceId;
}

export async function connectNewWorkspaceDaemonClient(): Promise<NewWorkspaceDaemonClient> {
  const DaemonClient = await loadDaemonClientConstructor();
  const webSocketFactory = createNodeWebSocketFactory();
  const client = new DaemonClient({
    url: getDaemonWsUrl(),
    clientId: `app-e2e-new-workspace-${randomUUID()}`,
    clientType: "cli",
    webSocketFactory,
  });
  await client.connect();
  return client;
}

export async function openProjectViaDaemon(
  client: NewWorkspaceDaemonClient,
  repoPath: string,
): Promise<OpenedProject> {
  const workspace = requireWorkspace(await client.openProject(repoPath));
  return {
    workspaceId: workspace.id,
    projectKey: workspace.projectId,
    projectDisplayName: workspace.projectDisplayName,
    workspaceName: workspace.name,
  };
}

export async function archiveWorkspaceFromDaemon(
  client: NewWorkspaceDaemonClient,
  workspaceId: string,
): Promise<void> {
  const payload = await client.archivePaseoWorktree({ worktreePath: workspaceId });
  if (payload.error) {
    throw new Error(payload.error.message);
  }
  if (!payload.success) {
    throw new Error(`Failed to archive workspace: ${workspaceId}`);
  }
}

export async function archiveLocalWorkspaceFromDaemon(
  client: NewWorkspaceDaemonClient,
  workspaceId: string,
): Promise<void> {
  const payload = await client.archiveWorkspace(workspaceId);
  if (payload.error) {
    throw new Error(payload.error);
  }
  if (!payload.archivedAt) {
    throw new Error(`Failed to archive workspace: ${workspaceId}`);
  }
}

export async function createWorktreeViaDaemon(
  client: NewWorkspaceDaemonClient,
  input: { cwd: string; slug: string },
): Promise<OpenedProject> {
  const payload = await client.createPaseoWorktree({
    cwd: input.cwd,
    worktreeSlug: input.slug,
  });
  const workspace = requireWorkspace(payload);
  return {
    workspaceId: workspace.id,
    projectKey: workspace.projectId,
    projectDisplayName: workspace.projectDisplayName,
    workspaceName: workspace.name,
  };
}

export async function clickNewWorkspaceButton(
  page: Page,
  input: { projectKey: string; projectDisplayName: string },
): Promise<void> {
  const projectRow = page.getByTestId(`sidebar-project-row-${input.projectKey}`).first();
  await expect(projectRow).toBeVisible({ timeout: 30_000 });
  await projectRow.hover();

  const button = page.getByTestId(`sidebar-project-new-worktree-${input.projectKey}`).first();
  await expect(button).toBeVisible({ timeout: 30_000 });
  await button.click();
}

export async function assertNewWorkspaceSidebarAndHeader(
  page: Page,
  input: { serverId: string; previousWorkspaceId: string; projectDisplayName: string },
): Promise<{ workspaceId: string }> {
  let workspaceId: string | null = null;
  const sidebarWorkspaceRows = page.locator(
    `[data-testid^="sidebar-workspace-row-${input.serverId}:"]`,
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const sidebarRowTestIds = await sidebarWorkspaceRows.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-testid") ?? ""),
    );
    workspaceId =
      sidebarRowTestIds
        .map((testId) => parseWorkspaceIdFromSidebarRowTestId(testId, input))
        .find((id) => id !== null) ?? null;
    if (workspaceId) {
      break;
    }
    await page.waitForTimeout(250);
  }

  if (!workspaceId || workspaceId === input.previousWorkspaceId) {
    const sidebarWorkspaceRowIds = await sidebarWorkspaceRows.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-testid") ?? "<missing-testid>"),
    );
    throw new Error(
      [
        "Expected a newly created workspace to load.",
        `Current URL: ${page.url()}`,
        `Sidebar rows: ${sidebarWorkspaceRowIds.join(", ") || "<none>"}`,
      ].join("\n"),
    );
  }

  const createdWorkspaceRow = page.getByTestId(
    `sidebar-workspace-row-${input.serverId}:${workspaceId}`,
  );
  await expect(createdWorkspaceRow.first()).toBeVisible({ timeout: 30_000 });

  await expectWorkspaceHeader(page, {
    title: workspaceLabelFromPath(workspaceId),
    subtitle: input.projectDisplayName,
  });

  return { workspaceId };
}
