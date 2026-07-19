import { expect, type Page } from "@playwright/test";
import type { DaemonClient as InternalDaemonClient } from "@getpaseo/client/internal/daemon-client";
import { decodeWorkspaceIdFromPathSegment } from "@/utils/host-routes";
import { connectDaemonClient } from "./daemon-client-loader";
import { daemonWsRoutePattern } from "./daemon-port";
import { expectWorkspaceHeader } from "./workspace-ui";

type NewWorkspaceDaemonClient = Pick<
  InternalDaemonClient,
  | "archivePaseoWorktree"
  | "archiveWorkspace"
  | "checkoutRefresh"
  | "close"
  | "connect"
  | "createPaseoWorktree"
  | "createWorkspace"
  | "fetchWorkspaces"
  | "getPaseoWorktreeList"
  | "getDaemonConfig"
  | "inspectWorkspaceRecovery"
  | "on"
  | "patchDaemonConfig"
  | "removeProject"
>;

type CreateWorkspacePayload = Awaited<ReturnType<NewWorkspaceDaemonClient["createWorkspace"]>>;
type WorkspacePayload = Pick<CreateWorkspacePayload, "error" | "workspace">;
type WorkspaceDescriptor = NonNullable<CreateWorkspacePayload["workspace"]>;

export interface OpenedProject {
  workspaceId: string;
  projectKey: string;
  projectDisplayName: string;
  workspaceName: string;
  workspaceDirectory: string;
}

function requireWorkspace(payload: WorkspacePayload) {
  if (payload.error) {
    throw new Error(payload.error);
  }
  if (!payload.workspace) {
    throw new Error("workspace.create returned no workspace.");
  }
  return payload.workspace;
}

function openedProjectFromWorkspace(workspace: WorkspaceDescriptor): OpenedProject {
  return {
    workspaceId: workspace.id,
    projectKey: workspace.projectId,
    projectDisplayName: workspace.projectDisplayName,
    workspaceName: workspace.name,
    workspaceDirectory: workspace.workspaceDirectory,
  };
}

async function fetchWorkspaceById(
  client: NewWorkspaceDaemonClient,
  workspaceId: string,
): Promise<WorkspaceDescriptor | null> {
  const payload = await client.fetchWorkspaces();
  return payload.entries.find((entry) => entry.id === workspaceId) ?? null;
}

async function waitForWorkspaceDescriptor(
  client: NewWorkspaceDaemonClient,
  workspaceId: string,
): Promise<WorkspaceDescriptor> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const workspace = await fetchWorkspaceById(client, workspaceId);
    if (workspace) {
      return workspace;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Workspace descriptor not found: ${workspaceId}`);
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

export async function connectNewWorkspaceDaemonClient(options?: {
  port?: number;
}): Promise<NewWorkspaceDaemonClient> {
  return connectDaemonClient<NewWorkspaceDaemonClient>({
    clientIdPrefix: "app-e2e-new-workspace",
    port: options?.port,
  });
}

export async function openProjectViaDaemon(
  client: NewWorkspaceDaemonClient,
  repoPath: string,
): Promise<OpenedProject> {
  const workspace = requireWorkspace(
    await client.createWorkspace({
      source: { kind: "directory", path: repoPath },
    }),
  );
  return openedProjectFromWorkspace(workspace);
}

export async function archiveWorkspaceFromDaemon(
  client: NewWorkspaceDaemonClient,
  workspaceDirectory: string,
  options?: { scope?: "workspace" | "worktree" },
): Promise<void> {
  const payload = await client.archivePaseoWorktree({
    worktreePath: workspaceDirectory,
    ...(options?.scope !== undefined ? { scope: options.scope } : {}),
  });
  if (payload.error) {
    throw new Error(payload.error.message);
  }
  if (!payload.success) {
    throw new Error(`Failed to archive workspace: ${workspaceDirectory}`);
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
  return openedProjectFromWorkspace(workspace);
}

export async function openNewWorkspaceComposer(
  page: Page,
  input: { projectKey: string; projectDisplayName: string },
): Promise<void> {
  const projectRow = page.getByTestId(`sidebar-project-row-${input.projectKey}`).first();
  await expect(projectRow).toBeVisible({ timeout: 30_000 });
  await projectRow.hover();

  const button = page.getByTestId(`sidebar-project-new-worktree-${input.projectKey}`).first();
  await expect(button).toBeVisible({ timeout: 30_000 });
  await button.click();

  await expect(page).toHaveURL(/\/new(?:\?.*)?$/, {
    timeout: 30_000,
  });
}

export async function openGlobalNewWorkspaceComposer(page: Page): Promise<void> {
  await page.getByTestId("sidebar-global-new-workspace").click();

  await expect(page).toHaveURL(/\/new(?:\?.*)?$/, {
    timeout: 30_000,
  });
}

export async function expectNewWorkspaceProjectSelected(
  page: Page,
  projectDisplayName: string,
): Promise<void> {
  const projectPicker = page.getByRole("button", { name: "Workspace project" });
  await expect(projectPicker).toBeVisible({ timeout: 30_000 });
  await expect(projectPicker).toContainText(projectDisplayName);
}

export async function fillNewWorkspaceDraft(page: Page, draft: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message agent..." });
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill(draft);
}

export async function expectNewWorkspaceDraft(page: Page, draft: string): Promise<void> {
  await expect(page.getByRole("textbox", { name: "Message agent..." })).toHaveValue(draft);
}

export async function selectNewWorkspaceHost(page: Page, hostLabel: string): Promise<void> {
  await page.getByTestId("host-picker-trigger").click();
  await page.getByText(hostLabel, { exact: true }).click();
}

export async function submitNewWorkspacePrompt(
  page: Page,
  prompt = "Hello from e2e",
): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message agent..." });
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill(prompt);
  const createButton = page
    .getByTestId("message-input-root")
    .getByRole("button", { name: "Create" });
  await expect(createButton).toBeVisible({ timeout: 30_000 });
  await createButton.click();
}

export async function clickNewWorkspaceButton(
  page: Page,
  input: { projectKey: string; projectDisplayName: string; prompt?: string },
): Promise<void> {
  await openNewWorkspaceComposer(page, input);
  await submitNewWorkspacePrompt(page, input.prompt);
}

export async function selectNewWorkspaceProject(
  page: Page,
  input: { projectKey: string; projectDisplayName: string },
): Promise<void> {
  const trigger = page.getByTestId("new-workspace-project-picker-trigger");
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();

  const option = page.getByTestId(`new-workspace-project-picker-option-${input.projectKey}`);
  await expect(option).toBeVisible({ timeout: 30_000 });
  await option.click();

  await expectNewWorkspaceProjectSelected(page, input.projectDisplayName);
}

// The isolation trigger renders the active isolation's label ("Local" / "New
// worktree"), so asserting its text proves what the screen currently remembers.
const ISOLATION_TRIGGER_LABEL: Record<"local" | "worktree", string> = {
  local: "Local",
  worktree: "New worktree",
};

export async function expectWorkspaceIsolationSelected(
  page: Page,
  isolation: "local" | "worktree",
): Promise<void> {
  const trigger = page.getByRole("button", { name: "Workspace isolation" });
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await expect(trigger).toContainText(ISOLATION_TRIGGER_LABEL[isolation]);
}

export async function selectWorkspaceIsolation(
  page: Page,
  isolation: "local" | "worktree",
): Promise<void> {
  const trigger = page.getByTestId("workspace-create-isolation-trigger");
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();

  // "New worktree" is only listed once the checkout status query confirms the
  // selected project is a git repo, so wait for the option to appear before
  // clicking it.
  const option = page.getByTestId(`workspace-create-isolation-${isolation}`);
  await expect(option).toBeVisible({ timeout: 30_000 });
  await option.click();
}

export async function submitNewWorkspaceEmpty(page: Page): Promise<void> {
  const createButton = page
    .getByTestId("message-input-root")
    .getByRole("button", { name: "Create" });
  await expect(createButton).toBeVisible({ timeout: 30_000 });
  await createButton.click();
}

export async function openStartingRefPicker(page: Page): Promise<void> {
  const trigger = page.getByTestId("new-workspace-ref-picker-trigger");
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();
}

export async function selectBranchInPicker(page: Page, name: string): Promise<void> {
  const branchRow = page.getByTestId(`new-workspace-ref-picker-branch-${name}`);
  await expect(branchRow).toBeVisible({ timeout: 30_000 });
  await branchRow.click();
}

export async function selectGitHubPrInPicker(page: Page, number: number): Promise<void> {
  const prRow = page.getByTestId(`new-workspace-ref-picker-pr-${number}`);
  await expect(prRow).toBeVisible({ timeout: 30_000 });
  await prRow.click();
}

export async function expectStartingRefPickerTriggerPr(
  page: Page,
  input: { number: number; title: string; headRef: string },
): Promise<void> {
  const trigger = page.getByRole("button", { name: "Starting ref" });
  await expect(trigger).toContainText(`#${input.number}`);
  await expect(trigger).toContainText(input.title);
  await expect(trigger).not.toContainText(input.headRef);
}

export async function openBranchPicker(page: Page): Promise<void> {
  const trigger = page.getByRole("button", { name: "Starting ref" });
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();
}

export async function selectPickerOptionByKeyboard(page: Page, label: string): Promise<void> {
  const searchInput = page.getByPlaceholder("Search branches and PRs");
  await expect(searchInput).toBeVisible({ timeout: 30_000 });
  await page.keyboard.type(label);
  await expect(page.getByTestId(`new-workspace-ref-picker-branch-${label}`)).toBeVisible({
    timeout: 10_000,
  });
  await page.keyboard.press("Enter");
}

export async function closeBranchPicker(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
}

export async function expectPickerOpen(page: Page): Promise<void> {
  await expect(page.getByTestId("combobox-desktop-container")).toBeVisible({ timeout: 30_000 });
}

export async function expectPickerClosed(page: Page): Promise<void> {
  await expect(page.getByTestId("combobox-desktop-container")).not.toBeVisible({
    timeout: 30_000,
  });
}

export async function expectPickerSelected(page: Page, label: string): Promise<void> {
  const trigger = page.getByRole("button", { name: "Starting ref" });
  await expect(trigger).toContainText(label);
}

export async function expectComposerGithubAttachmentPill(
  page: Page,
  input: { number: number; title: string },
): Promise<void> {
  const pills = page.getByTestId("composer-github-attachment-pill");
  await expect(pills).toHaveCount(1);
  await expect(pills.first()).toContainText(`#${input.number}`);
  await expect(pills.first()).toContainText(input.title);
}

export async function assertNewWorkspaceSidebarAndHeader(
  page: Page,
  input: {
    serverId: string;
    client: NewWorkspaceDaemonClient;
    previousWorkspaceId: string;
    projectDisplayName: string;
    assertSidebarRow?: boolean;
    assertHeader?: boolean;
  },
): Promise<{ workspaceId: string; workspaceName: string; workspaceDirectory: string }> {
  // URL is the source of truth so concurrent sidebar rows cannot satisfy this.
  await expect
    .poll(
      () => {
        const workspaceId = parseWorkspaceIdFromPageUrl(page, input.serverId);
        return workspaceId && workspaceId !== input.previousWorkspaceId ? workspaceId : null;
      },
      { timeout: 60_000 },
    )
    .not.toBeNull();

  const workspaceId = parseWorkspaceIdFromPageUrl(page, input.serverId);
  if (!workspaceId || workspaceId === input.previousWorkspaceId) {
    throw new Error(`Expected URL to redirect to a new workspace.\nCurrent URL: ${page.url()}`);
  }

  const workspace = await waitForWorkspaceDescriptor(input.client, workspaceId);

  if (input.assertSidebarRow !== false) {
    const createdWorkspaceRow = page.getByTestId(
      `sidebar-workspace-row-${input.serverId}:${workspace.id}`,
    );
    await expect(createdWorkspaceRow.first()).toBeVisible({ timeout: 30_000 });
  }

  if (input.assertHeader !== false) {
    await expectWorkspaceHeader(page, {
      title: workspace.name,
      subtitle: input.projectDisplayName,
    });
  }

  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceDirectory: workspace.workspaceDirectory,
  };
}

type WebSocketMessage = string | Buffer;

function parseWebSocketJson(message: WebSocketMessage): unknown {
  const rawMessage = typeof message === "string" ? message : message.toString("utf8");
  try {
    return JSON.parse(rawMessage);
  } catch {
    return null;
  }
}

function getSessionMessage(message: WebSocketMessage): Record<string, unknown> | null {
  const envelope = parseWebSocketJson(message);
  if (!envelope || typeof envelope !== "object") {
    return null;
  }
  const maybeEnvelope = envelope as { type?: unknown; message?: unknown };
  if (maybeEnvelope.type !== "session" || !maybeEnvelope.message) {
    return null;
  }
  if (typeof maybeEnvelope.message !== "object") {
    return null;
  }
  return maybeEnvelope.message as Record<string, unknown>;
}

function getStringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" ? value : null;
}

export interface AgentCreatedDelayControl {
  release(): void;
  waitForCreateRequest(): Promise<void>;
  waitForDelayedCreatedStatus(): Promise<void>;
}

export async function delayBrowserAgentCreatedStatus(
  page: Page,
): Promise<AgentCreatedDelayControl> {
  const daemonPortPattern = daemonWsRoutePattern();
  const createRequestIds = new Set<string>();
  const delayedForwards: Array<() => void> = [];
  let releaseRequested = false;
  let resolveCreateRequest: (() => void) | null = null;
  let resolveDelayedCreatedStatus: (() => void) | null = null;
  const createRequestSeen = new Promise<void>((resolve) => {
    resolveCreateRequest = resolve;
  });
  const delayedCreatedStatusSeen = new Promise<void>((resolve) => {
    resolveDelayedCreatedStatus = resolve;
  });

  await page.routeWebSocket(daemonPortPattern, (ws) => {
    const server = ws.connectToServer();

    ws.onMessage((message) => {
      const sessionMessage = getSessionMessage(message);
      if (sessionMessage?.type === "create_agent_request") {
        const requestId = getStringField(sessionMessage, "requestId");
        if (requestId) {
          createRequestIds.add(requestId);
          resolveCreateRequest?.();
        }
      }
      server.send(message);
    });

    server.onMessage((message) => {
      const sessionMessage = getSessionMessage(message);
      const payload =
        sessionMessage?.type === "status" && typeof sessionMessage.payload === "object"
          ? (sessionMessage.payload as Record<string, unknown>)
          : null;
      const requestId = payload ? getStringField(payload, "requestId") : null;

      if (payload?.status === "agent_created" && requestId && createRequestIds.has(requestId)) {
        resolveDelayedCreatedStatus?.();
        if (releaseRequested) {
          ws.send(message);
          return;
        }
        delayedForwards.push(() => ws.send(message));
        return;
      }

      ws.send(message);
    });
  });

  return {
    release() {
      releaseRequested = true;
      for (const forward of delayedForwards.splice(0)) {
        forward();
      }
    },
    waitForCreateRequest: () => createRequestSeen,
    waitForDelayedCreatedStatus: () => delayedCreatedStatusSeen,
  };
}
