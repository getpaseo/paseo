import { expect, type BrowserContext, type Page } from "@playwright/test";
import type { CreateAgentRequestMessage } from "@getpaseo/protocol/messages";
import type { DaemonClient as InternalDaemonClient } from "@getpaseo/client/internal/daemon-client";
import { decodeWorkspaceIdFromPathSegment } from "@/utils/host-routes";
import { connectDaemonClient } from "./daemon-client-loader";
import { daemonWsRoutePattern } from "./daemon-port";
import { projectEquivalenceViewKey } from "./project-view-key";
import { expectWorkspaceHeader } from "./workspace-ui";
import { withProjectOwnership } from "./project-ownership";

type NewWorkspaceDaemonClient = Pick<
  InternalDaemonClient,
  | "archivePaseoWorktree"
  | "archiveWorkspace"
  | "checkoutRefresh"
  | "close"
  | "connect"
  | "createPaseoWorktree"
  | "createWorkspace"
  | "fetchAgents"
  | "fetchWorkspaces"
  | "getPaseoWorktreeList"
  | "getDaemonConfig"
  | "installDirectoryPlugin"
  | "disablePlugin"
  | "enablePlugin"
  | "inspectWorkspaceRecovery"
  | "listProjects"
  | "listTerminals"
  | "on"
  | "patchDaemonConfig"
  | "removeProject"
  | "removePlugin"
  | "reloadPlugin"
  | "setWorkspaceTitle"
>;

type CreateWorkspacePayload = Awaited<ReturnType<NewWorkspaceDaemonClient["createWorkspace"]>>;
type WorkspacePayload = Pick<CreateWorkspacePayload, "error" | "workspace">;
type WorkspaceDescriptor = NonNullable<CreateWorkspacePayload["workspace"]>;

export interface OpenedProject {
  workspaceId: string;
  projectId: string;
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

async function openedProjectFromWorkspace(
  client: NewWorkspaceDaemonClient,
  workspace: WorkspaceDescriptor,
): Promise<OpenedProject> {
  const payload = await client.listProjects();
  const project = payload.projects.find((candidate) => candidate.projectId === workspace.projectId);
  if (!project?.projectKey) {
    throw new Error(`Project ${workspace.projectId} has no project key`);
  }
  return {
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    projectKey: project.projectKey,
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
  ownProjects?: boolean;
}): Promise<NewWorkspaceDaemonClient> {
  const client = await connectDaemonClient<NewWorkspaceDaemonClient>({
    clientIdPrefix: "app-e2e-new-workspace",
    port: options?.port,
  });
  if (options?.ownProjects === false) return client;

  return withProjectOwnership(client);
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
  return openedProjectFromWorkspace(client, workspace);
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
  return openedProjectFromWorkspace(client, workspace);
}

export async function openNewWorkspaceComposer(
  page: Page,
  input: { projectKey: string; projectDisplayName: string },
): Promise<void> {
  const projectViewKey = projectEquivalenceViewKey(input.projectKey);
  const projectRow = page.getByTestId(`sidebar-project-row-${projectViewKey}`).first();
  await expect(projectRow).toBeVisible({ timeout: 30_000 });
  await projectRow.hover();

  const button = page.getByTestId(`sidebar-project-new-worktree-${projectViewKey}`).first();
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

export async function openMissingProjectNewWorkspaceComposer(
  page: Page,
  input: { serverId: string; projectId: string; sourceDirectory: string },
): Promise<void> {
  const query = new URLSearchParams({
    serverId: input.serverId,
    projectId: input.projectId,
    dir: input.sourceDirectory,
    name: "Missing project",
  });
  await page.goto(`/new?${query.toString()}`);
  await expect(page).toHaveURL(/\/new\?.*projectId=/u, { timeout: 30_000 });
}

export async function expectNewWorkspaceControlsEnabled(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Workspace project" })).toBeEnabled({
    timeout: 30_000,
  });
  await expect(page.getByRole("textbox", { name: "Message agent..." })).toBeEditable({
    timeout: 30_000,
  });
}

export async function openNewWorkspaceProjectPickerWithShortcut(page: Page): Promise<void> {
  await page.keyboard.press("Control+P");

  const searchInput = page.getByPlaceholder("Search projects");
  await expect(searchInput).toBeVisible({ timeout: 30_000 });
  await expect(searchInput).toBeFocused();
}

export async function expectNewWorkspaceProjectSelected(
  page: Page,
  projectDisplayName: string,
): Promise<void> {
  const projectPicker = page.getByRole("button", { name: "Workspace project" });
  await expect(projectPicker).toBeVisible({ timeout: 30_000 });
  await expect(projectPicker).toContainText(projectDisplayName);
}

export async function expectNewWorkspaceTriggerLabelsAligned(
  page: Page,
  input: { projectLabel: string; hostLabel: string },
): Promise<void> {
  const projectTrigger = page.getByRole("button", { name: "Workspace project" });
  const hostTrigger = page.getByRole("button", { name: "Host", exact: true });
  const projectLabel = projectTrigger.getByText(input.projectLabel, { exact: true });
  const hostLabel = hostTrigger.getByText(input.hostLabel, { exact: true });
  await Promise.all([
    expect(projectLabel).toBeVisible({ timeout: 30_000 }),
    expect(hostLabel).toBeVisible({ timeout: 30_000 }),
  ]);
  const [projectTriggerBox, projectLabelBox, hostTriggerBox, hostLabelBox] = await Promise.all([
    projectTrigger.boundingBox(),
    projectLabel.boundingBox(),
    hostTrigger.boundingBox(),
    hostLabel.boundingBox(),
  ]);
  if (!projectTriggerBox || !projectLabelBox || !hostTriggerBox || !hostLabelBox) {
    throw new Error("New Workspace trigger geometry could not be measured");
  }

  const projectLabelInset = projectLabelBox.x - projectTriggerBox.x;
  const hostLabelInset = hostLabelBox.x - hostTriggerBox.x;
  expect(hostLabelInset).toBeCloseTo(projectLabelInset, 0);
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
  const trigger = page.getByTestId("host-picker-trigger");
  await trigger.click();
  await page.getByRole("button", { name: hostLabel, exact: true }).click();
  await expect(trigger).toContainText(hostLabel);
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
  input: { projectKey: string; projectDisplayName: string; projectViewKey?: string },
): Promise<void> {
  const trigger = page.getByTestId("new-workspace-project-picker-trigger");
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();

  const projectViewKey = input.projectViewKey ?? projectEquivalenceViewKey(input.projectKey);
  const option = page.getByTestId(`new-workspace-project-picker-option-${projectViewKey}`);
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

  // Isolation options are derived from project capability. Wait for the option
  // so this helper also covers route-to-project reconciliation.
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

export async function searchAndSelectBranchInPicker(page: Page, name: string): Promise<void> {
  const searchInput = page.getByPlaceholder("Search branches and PRs");
  await expect(searchInput).toBeVisible({ timeout: 30_000 });
  await searchInput.fill(name);
  await selectBranchInPicker(page, name);
}

// Ref picker rows are named for a user: "main, origin branch" is the upstream copy and
// "main, local branch, 2 commits ahead of origin main" is the local one.
export function startingRefRow(page: Page, accessibleName: string) {
  return page.getByRole("button", { name: accessibleName, exact: true });
}

export async function expectStartingRefRows(page: Page, accessibleNames: string[]): Promise<void> {
  for (const name of accessibleNames) {
    await expect(startingRefRow(page, name)).toBeVisible({ timeout: 30_000 });
  }
}

export async function captureStartingRefPicker(page: Page, screenshotPath: string): Promise<void> {
  await expect(page.getByTestId("combobox-desktop-container")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("combobox-desktop-container").screenshot({ path: screenshotPath });
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

export async function pasteGithubPrUrl(
  page: Page,
  context: BrowserContext,
  url: string,
): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message agent..." });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate((value) => navigator.clipboard.writeText(value), url);
  await composer.focus();
  await page.keyboard.press("Control+V");
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

export interface WorkspaceCreatedDelayControl {
  agentRequests: readonly CreateAgentRequestMessage[];
  release(): void;
  waitForCreateRequest(): Promise<void>;
}

/**
 * Holds `workspace.create.response` so a test can act as the user does while the daemon is still
 * running `git worktree add` — most importantly, navigate somewhere else.
 */
export async function delayBrowserWorkspaceCreatedResponse(
  page: Page,
): Promise<WorkspaceCreatedDelayControl> {
  const daemonPortPattern = daemonWsRoutePattern();
  const agentRequests: CreateAgentRequestMessage[] = [];
  const createRequestIds = new Set<string>();
  const delayedForwards: Array<() => void> = [];
  let releaseRequested = false;
  let resolveCreateRequest: (() => void) | null = null;
  const createRequestSeen = new Promise<void>((resolve) => {
    resolveCreateRequest = resolve;
  });

  await page.routeWebSocket(daemonPortPattern, (ws) => {
    const server = ws.connectToServer();

    ws.onMessage((message) => {
      const sessionMessage = getSessionMessage(message);
      if (sessionMessage?.type === "create_agent_request")
        agentRequests.push(sessionMessage as CreateAgentRequestMessage);
      if (sessionMessage?.type === "workspace.create.request") {
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
        sessionMessage?.type === "workspace.create.response" &&
        typeof sessionMessage.payload === "object"
          ? (sessionMessage.payload as Record<string, unknown>)
          : null;
      const requestId = payload ? getStringField(payload, "requestId") : null;

      if (requestId && createRequestIds.has(requestId) && !releaseRequested) {
        delayedForwards.push(() => ws.send(message));
        return;
      }

      ws.send(message);
    });
  });

  return {
    agentRequests,
    release() {
      releaseRequested = true;
      for (const forward of delayedForwards.splice(0)) {
        forward();
      }
    },
    waitForCreateRequest: () => createRequestSeen,
  };
}

type WorkspaceEntry = Awaited<
  ReturnType<NewWorkspaceDaemonClient["fetchWorkspaces"]>
>["entries"][number];

/**
 * Waits for a workspace the caller did not already know about, and returns it. Tests that create a
 * workspace without navigating to it have no route to assert on, so the daemon's own list is the
 * signal that creation finished.
 */
export async function waitForCreatedWorkspace(
  client: NewWorkspaceDaemonClient,
  knownWorkspaceIds: ReadonlySet<string>,
  options?: { timeout?: number },
): Promise<WorkspaceEntry> {
  let created: WorkspaceEntry | undefined;
  await expect
    .poll(
      async () => {
        const payload = await client.fetchWorkspaces();
        created = payload.entries.find((entry) => !knownWorkspaceIds.has(entry.id));
        return created !== undefined;
      },
      { timeout: options?.timeout ?? 60_000 },
    )
    .toBe(true);
  if (!created) {
    throw new Error("Workspace list reported a new workspace but it could not be read back");
  }
  return created;
}

export async function countWorkspaceAgents(
  client: NewWorkspaceDaemonClient,
  workspaceId: string,
): Promise<number> {
  const payload = await client.fetchAgents({ filter: { includeArchived: true } });
  return payload.entries.filter((entry) => entry.agent.workspaceId === workspaceId).length;
}

export async function countWorkspaceTerminals(
  client: NewWorkspaceDaemonClient,
  workspaceId: string,
): Promise<number> {
  const payload = await client.listTerminals(undefined, undefined, { workspaceId });
  return payload.terminals.length;
}
