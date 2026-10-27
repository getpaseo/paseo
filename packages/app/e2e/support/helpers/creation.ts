import { awaitAssistantMessage } from "./agent-stream";
import { forkMostRecentAssistantTurnToNewWorkspace } from "./assistant-fork";
import type { WorkspaceCreateRequest } from "@getpaseo/protocol/messages";
import { expect, type Page } from "@playwright/test";
import { daemonWsRoutePattern } from "./daemon-port";
import { gotoAppShell } from "./app";
import { gotoWorkspace } from "./launcher";
import { attachComposerTestImage, fillComposerDraft } from "./composer";
import { createAgentTabFromMenu } from "./workspace-tabs";
import {
  connectNewWorkspaceDaemonClient,
  openNewWorkspaceComposer,
  openStartingRefPicker,
  startingRefRow,
  selectWorkspaceIsolation,
  loadSessionMessageReaders,
} from "./new-workspace";
import { seedWorkspace } from "./seed-client";
import {
  waitForSidebarHydration,
  switchWorkspaceViaSidebar,
  workspaceDeckEntryLocator,
} from "./workspace-ui";
import { getServerId } from "./server-id";
import { revealSidebarProjectWorkspaces } from "./sidebar";
import { WORKSPACE_DECK_MAX_MOUNTED_WORKSPACES } from "@/screens/workspace/workspace-deck-retention";
import type { installDaemonWebSocketGate } from "./daemon-websocket-gate";

/** Capture the submitted agent options; optionally stop provisioning for wire-only assertions. */
export async function captureWorkspaceAgentRequest(page: Page, options: { block: boolean }) {
  const frames = await loadSessionMessageReaders();
  type AgentIntent = NonNullable<WorkspaceCreateRequest["agent"]>;
  let resolveRequest!: (agent: AgentIntent) => void;
  const request = new Promise<AgentIntent>((resolve) => {
    resolveRequest = resolve;
  });
  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((frame) => {
      const message = frames.client(frame);
      if (message?.type === "workspace.create.request" && message.agent) {
        resolveRequest(message.agent);
        if (options.block) return;
      }
      server.send(frame);
    });
    server.onMessage((frame) => ws.send(frame));
  });
  return { waitForRequest: () => request };
}

/** Hold the creation request before the daemon can reserve or provision anything. */
/** Holds each workspace request with an agent until `release` sends the held requests. */
export async function holdWorkspaceProvisioning(page: Page) {
  const frames = await loadSessionMessageReaders();
  let held: Array<() => void> = [];
  const requests: WorkspaceCreateRequest[] = [];
  let agentPrompts = 0;
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((frame) => {
      const message = frames.client(frame);
      if (message?.type === "send_agent_message_request") agentPrompts++;
      if (message?.type === "workspace.create.request" && message.agent) {
        held.push(() => server.send(frame));
        requests.push(message);
        return;
      }
      server.send(frame);
    });
    server.onMessage((frame) => browser.send(frame));
  });
  async function waitForRequests(count: number) {
    await expect.poll(() => requests.length).toBe(count);
    return requests[count - 1]!;
  }
  return {
    waitForRequest: () => waitForRequests(1),
    waitForRequests,
    release: () => {
      const sending = held;
      held = [];
      for (const send of sending) send();
    },
    agentPrompts: () => agentPrompts,
  };
}

export async function pressSubmitBeforeTheNextRender(page: Page, name: string): Promise<void> {
  const create = page.getByRole("button", { name, exact: true });
  await expect(create).toBeEnabled();
  // Dispatch the queued clicks in one JS task, before pending state can paint.
  // Exercise DOM events rather than calling the app's submit handler directly.
  await create.evaluate((button) => {
    for (let click = 0; click < 3; click++) {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });
}

export async function observeCreationRequests(page: Page) {
  const frames = await loadSessionMessageReaders();
  const pending = new Set<string>();
  let workspaceRequests = 0;
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const request = frames.client(payload);
      if (request?.type === "workspace.create.request") workspaceRequests++;
      if (
        request?.type === "workspace.create.request" ||
        request?.type === "agent.create.request"
      ) {
        pending.add(request.requestId);
      }
    });
    socket.on("framereceived", ({ payload }) => {
      const response = frames.server(payload);
      if (
        response?.type === "workspace.create.response" ||
        response?.type === "agent.create.response" ||
        (response?.type === "status" &&
          (response.payload.status === "agent_created" ||
            response.payload.status === "agent_create_failed"))
      ) {
        const requestId = response.payload.requestId;
        if (typeof requestId === "string") pending.delete(requestId);
      }
    });
  });
  return {
    workspaceRequests: () => workspaceRequests,
    async settled() {
      await expect.poll(() => pending.size).toBe(0);
    },
  };
}

export async function retryNextAgentCreation(page: Page) {
  const frames = await loadSessionMessageReaders();
  const retryIds = new Set<string>();
  const results: Array<{ status: string; agentId?: string }> = [];
  let repeated = false;
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((frame) => {
      const request = frames.client(frame);
      if (!repeated && request?.type === "agent.create.request") {
        repeated = true;
        for (let attempt = 1; attempt <= 3; attempt++) {
          const requestId = attempt === 1 ? request.requestId : `${request.requestId}-${attempt}`;
          retryIds.add(requestId);
          // Keep the app's operation key and payload; only RPC correlation changes.
          server.send(JSON.stringify({ type: "session", message: { ...request, requestId } }));
        }
        return;
      }
      server.send(frame);
    });
    server.onMessage((frame) => {
      const response = frames.server(frame);
      if (
        response?.type === "agent.create.response" &&
        retryIds.delete(response.payload.requestId)
      ) {
        results.push({
          status: response.payload.error ? "agent_create_failed" : "agent_created",
          agentId: response.payload.agent?.id,
        });
      }
      browser.send(frame);
    });
  });
  return {
    async completedAgentIds() {
      await expect.poll(() => results.length).toBe(3);
      expect(results.map((result) => result.status)).toEqual([
        "agent_created",
        "agent_created",
        "agent_created",
      ]);
      return results.map((result) => result.agentId);
    },
  };
}

function agentComposer(page: Page) {
  // Retained workspaces keep hidden composers mounted beside the focused one.
  return page.getByRole("textbox", { name: "Message agent..." }).filter({ visible: true });
}

export async function createCreationScenario(page: Page) {
  const requests = await observeCreationRequests(page);
  const project = await seedWorkspace({
    repoPrefix: "creation-idempotency-",
    repo: {
      files: [{ path: "nested/context.txt", content: "Nested agent working directory" }],
      branches: ["recovery-base"],
    },
  });
  let workspaceId = project.workspaceId;
  const evictionWorkspaceIds = new Set<string>();
  const sourceClients: Array<{ close(): Promise<void> }> = [];
  return {
    cleanup: async () => {
      for (const client of sourceClients) await client.close();
      await project.cleanup();
    },
    async openNestedAgentFork(isolation: "local" | "worktree") {
      const cwd = `${project.repoPath}/nested`;
      const sourceClient = await connectNewWorkspaceDaemonClient();
      sourceClients.push(sourceClient);
      const source = await sourceClient.createWorkspace({
        source: { kind: "directory", path: project.repoPath },
        agent: {
          config: { provider: "mock", model: "e2e-fast-stream", modeId: "load-test", cwd },
          initialPrompt: "emit 1 coalesced agent stream updates for the source conversation.",
        },
      });
      if (!source.agent || !source.workspace)
        throw new Error(source.error ?? "Missing nested source agent");
      evictionWorkspaceIds.add(source.workspace.id);
      await project.client.waitForFinish(source.agent.id, 20_000);
      await gotoWorkspace(page, source.workspace.id);
      await awaitAssistantMessage(page);
      await forkMostRecentAssistantTurnToNewWorkspace(page);
      await selectWorkspaceIsolation(page, isolation);
      return cwd;
    },
    attachImage: () => attachComposerTestImage(page),
    async expectImageVisible() {
      await expect(
        page
          .getByRole("button", { name: "Open image attachment", exact: true })
          .filter({ visible: true }),
      ).toHaveCount(1);
    },
    async expectInitialPromptOnce(prompt: string) {
      const agents = (await project.client.fetchAgents()).entries.filter(
        ({ agent }) => agent.workspaceId === workspaceId,
      );
      expect(agents).toHaveLength(1);
      const reader = await connectNewWorkspaceDaemonClient();
      try {
        const timeline = await reader.fetchAgentTimeline(agents[0]!.agent.id);
        expect(timeline.entries.filter(({ item }) => item.type === "user_message")).toHaveLength(1);
        expect(
          timeline.entries.filter(
            ({ item }) => item.type === "user_message" && item.text === prompt,
          ),
        ).toHaveLength(1);
      } finally {
        await reader.close();
      }
    },
    async expectNestedAgentCwd() {
      const workspace = (await project.client.fetchWorkspaces()).entries.find(
        (entry) => entry.id === workspaceId,
      )!;
      const nestedAgent = (await project.client.fetchAgents()).entries.find(
        ({ agent }) => agent.workspaceId === workspaceId,
      )!.agent;
      expect(nestedAgent.cwd).toBe(`${workspace.workspaceDirectory}/nested`);
    },
    async closePendingAgent(agentId: string) {
      await page.getByTestId(`workspace-tab-agent_${agentId}`).filter({ visible: true }).hover();
      await page.getByTestId(`workspace-agent-close-${agentId}`).filter({ visible: true }).click();
      await expect(
        page.getByTestId(`workspace-tab-agent_${agentId}`).filter({ visible: true }),
      ).toHaveCount(0);
    },
    async openWorkspaceForm(isolation: "local" | "worktree") {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, project);
      await selectWorkspaceIsolation(page, isolation);
    },
    async selectWorktreeBranch(name: string) {
      await openStartingRefPicker(page);
      await startingRefRow(page, `${name}, local branch`).click();
    },
    async openAgentDraft() {
      await gotoWorkspace(page, project.workspaceId);
      await createAgentTabFromMenu(page);
    },
    async startAnotherDraft() {
      await createAgentTabFromMenu(page);
    },
    async submitPrompt(prompt: string, button = "Send message") {
      await fillComposerDraft(page, prompt);
      await page.getByRole("button", { name: button, exact: true }).click();
    },
    async submitRepeatedly(button: string, prompt?: string) {
      if (prompt) await fillComposerDraft(page, prompt);
      await pressSubmitBeforeTheNextRender(page, button);
    },
    async expectNormalAgentComposer() {
      await expect(agentComposer(page)).toBeEditable();
      // Provisioning belongs to the workspace header and sidebar, not the conversation.
      await expect(page.getByText("Creating workspace and agent…", { exact: true })).toHaveCount(0);
    },
    async expectAgentCannotBeStoppedYet() {
      await expect(
        page.getByRole("button", { name: "Stop agent" }).filter({ visible: true }),
      ).toBeDisabled();
    },
    async queueFollowUp(prompt: string) {
      await agentComposer(page).fill(prompt);
      await agentComposer(page).press("Enter");
      await expect(
        page.getByRole("button", { name: "Send queued message now" }).filter({ visible: true }),
      ).toBeVisible();
      await expect(page.getByText(prompt, { exact: true }).filter({ visible: true })).toBeVisible();
    },
    async expectQueuedFollowUp(prompt: string) {
      await expect(
        page.getByRole("button", { name: "Send queued message now" }).filter({ visible: true }),
      ).toHaveCount(1);
      await expect(page.getByText(prompt, { exact: true }).filter({ visible: true })).toBeVisible();
    },
    async resubmitWorkspace() {
      await page.getByRole("button", { name: "Create", exact: true }).click();
    },
    async expectAgentConfig(config: { model: string; modeId: string }) {
      const agent = (await project.client.fetchAgents()).entries.find(
        (entry) => entry.agent.workspaceId === workspaceId,
      )!.agent;
      expect({ model: agent.model, modeId: agent.currentModeId }).toEqual(config);
    },
    async typeComposerDraft(text: string) {
      await agentComposer(page).fill(text);
      // The composer publishes typed text to its draft after the next paint.
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))),
      );
    },
    async expectComposerDraft(text: string) {
      await expect(agentComposer(page)).toHaveValue(text);
    },
    async expectAgentNotWorking() {
      await expect(
        page.getByTestId("turn-working-indicator").filter({ visible: true }),
      ).toHaveCount(0);
    },
    async expectTimelineSettled() {
      await expect(page.getByText("Updating messages", { exact: true })).toHaveCount(0);
    },
    async expectUserMessagesInOrder(prompts: string[]) {
      const agent = (await project.client.fetchAgents()).entries.find(
        (entry) => entry.agent.workspaceId === workspaceId,
      );
      const reader = await connectNewWorkspaceDaemonClient();
      try {
        await expect
          .poll(async () =>
            (await reader.fetchAgentTimeline(agent!.agent.id)).entries.flatMap(({ item }) =>
              item.type === "user_message" ? [item.text] : [],
            ),
          )
          .toEqual(prompts);
      } finally {
        await reader.close();
      }
    },
    async expectPromptVisible(prompt?: string) {
      // Inactive agent tabs retain their timeline DOM beside the visible draft.
      const rows = page.getByTestId("user-message").filter({ visible: true });
      await expect(prompt ? rows.filter({ hasText: prompt }) : rows.first()).toBeVisible();
    },
    async expectWorkspaceReadyBeforeAgentCompletion() {
      await expect(page).toHaveURL(/\/workspace\//);
      await expect(page.getByTestId("user-message").first()).toBeVisible();
      await expect(
        page
          .locator('[data-testid^="workspace-tab-agent_"][aria-selected="true"]')
          .filter({ visible: true }),
      ).toBeVisible();
    },
    async expectAgentStillStarting() {
      await this.expectWorkspaceReadyBeforeAgentCompletion();
      expect((await project.client.fetchAgents()).entries).toHaveLength(0);
    },
    async expectCreatedAgentError() {
      await requests.settled();
      await expect(
        page
          .getByTestId("assistant-message")
          .filter({ hasText: "[System Error] Requested mock prompt rejection", visible: true }),
      ).toBeVisible();
      await expect(
        page
          .locator('[data-testid^="workspace-tab-agent_"][aria-selected="true"]')
          .filter({ visible: true }),
      ).toBeVisible();
      await expect(
        page.locator('[data-testid^="workspace-tab-draft_"]').filter({ visible: true }),
      ).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toBeEditable();
      await expect(page.getByTestId("turn-working-indicator")).toHaveCount(0);
    },
    async expectPromptBeforeError(prompt: string) {
      const messages = page
        .getByTestId("user-message")
        .or(page.getByTestId("assistant-message"))
        .filter({ visible: true });
      await expect(messages).toHaveCount(2);
      await expect(messages.nth(0)).toContainText(prompt);
      await expect(messages.nth(1)).toContainText("[System Error]");
      await expect(messages.nth(1)).toBeInViewport();
    },
    async reloadAgent() {
      await page.reload();
      await expect(page.getByText("Updating messages", { exact: true })).toHaveCount(0);
      await this.expectCreatedAgentError();
    },
    async expectAssistantReply() {
      await expect(
        page
          .getByTestId("assistant-message")
          .filter({ visible: true, hasNotText: "[System Error]" })
          .first(),
      ).toBeVisible();
    },
    async expectFailedAgentDraft(prompt: string) {
      await requests.settled();
      await expect(
        page
          .locator('[data-testid^="workspace-tab-draft_"][aria-selected="true"]')
          .filter({ visible: true }),
      ).toBeVisible();
      await expect(
        page
          .getByText(/Creation startup failed for test/)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
      await expect(agentComposer(page)).toHaveValue(prompt);
      await this.expectNoCreationRecovery();
    },
    async resendFailedDraft() {
      await page.getByRole("button", { name: "Send message", exact: true }).click();
    },
    async expectReturnedToNewWorkspace(prompt: string, error: string) {
      await requests.settled();
      await expect(page).toHaveURL(/\/new\?/);
      await expect(agentComposer(page)).toHaveValue(prompt);
      await expect(page.getByText(error).filter({ visible: true }).first()).toBeVisible();
      await this.expectNoCreationRecovery();
      expect(requests.workspaceRequests()).toBe(1);
      expect(
        (await project.client.fetchWorkspaces()).entries.filter(
          (workspace) =>
            workspace.projectId === project.projectId &&
            workspace.id !== project.workspaceId &&
            !evictionWorkspaceIds.has(workspace.id),
        ),
      ).toHaveLength(0);
    },
    async expectNoCreationRecovery() {
      await expect(page.getByRole("button", { name: "Retry creation", exact: true })).toHaveCount(
        0,
      );
      await expect(page.getByRole("button", { name: "Return to draft", exact: true })).toHaveCount(
        0,
      );
    },
    async expectOneCreatedWorkspace() {
      await expect(page).toHaveURL(/\/workspace\//);
      await requests.settled();
      const workspaces = (await project.client.fetchWorkspaces()).entries.filter(
        (workspace) =>
          workspace.projectId === project.projectId &&
          workspace.id !== project.workspaceId &&
          !evictionWorkspaceIds.has(workspace.id),
      );
      expect(workspaces).toHaveLength(1);
      workspaceId = workspaces[0]!.id;
    },
    async expectAgentCount(count: number) {
      await requests.settled();
      await expect
        .poll(
          async () =>
            (await project.client.fetchAgents()).entries.filter(
              ({ agent }) => agent.workspaceId === workspaceId,
            ).length,
        )
        .toBe(count);
    },
    async agentIds() {
      await requests.settled();
      return (await project.client.fetchAgents()).entries
        .filter(({ agent }) => agent.workspaceId === workspaceId)
        .map(({ agent }) => agent.id);
    },
    async expectAgentTitle(title: string) {
      await expect
        .poll(
          async () =>
            (await project.client.fetchAgents()).entries.find(
              ({ agent }) => agent.workspaceId === workspaceId,
            )?.agent.title,
        )
        .toBe(title);
    },
    async evictAndReturnToDraft() {
      workspaceId = new URL(page.url()).pathname.split("/workspace/")[1]!;
      const draft = page
        .locator(
          '[data-testid^="workspace-tab-draft_"][aria-selected="true"], [data-testid^="workspace-tab-agent_"][aria-selected="true"]',
        )
        .filter({ visible: true })
        .first();
      const draftTestId = await draft.getAttribute("data-testid");
      expect(draftTestId).not.toBeNull();
      for (let index = 0; index < WORKSPACE_DECK_MAX_MOUNTED_WORKSPACES; index++) {
        const result = await project.client.createWorkspace({
          source: { kind: "directory", path: project.repoPath },
        });
        if (!result.workspace) throw new Error(result.error ?? "Failed to seed eviction workspace");
        evictionWorkspaceIds.add(result.workspace.id);
        await switchWorkspaceViaSidebar({
          page,
          serverId: getServerId(),
          workspaceId: result.workspace.id,
        });
      }
      await expect(workspaceDeckEntryLocator(page, getServerId(), workspaceId)).toHaveCount(0);
      await revealSidebarProjectWorkspaces(page, project.projectKey);
      await switchWorkspaceViaSidebar({ page, serverId: getServerId(), workspaceId });
      await page
        .getByTestId(draftTestId!)
        .filter({ visible: true })
        .click({ position: { x: 12, y: 13 } });
    },
  };
}

export function createPromptRetryScenario(
  page: Page,
  gate: Awaited<ReturnType<typeof installDaemonWebSocketGate>>,
  kind: "agent" | "workspace" = "agent",
) {
  const requestType = `${kind}.create.request`;
  const responseType = `${kind}.create.response`;
  let firstMessage: ReturnType<typeof gate.getClientRequests>[number] | undefined;
  return {
    holdAcknowledgement() {
      gate.holdNextServerMessage(responseType);
    },
    async waitForDeliveredPrompt() {
      await gate.waitForHeldServerMessage(responseType);
      firstMessage = gate.getClientRequests(requestType).at(-1);
    },
    async disconnectAndReconnect() {
      const fetches = gate.getClientRequestCount("fetch_agents_request");
      await gate.drop();
      gate.restore();
      await expect
        .poll(() => gate.getClientRequestCount("fetch_agents_request"))
        .toBeGreaterThan(fetches);
    },
    async expectSameAgentAndMessage() {
      expect(gate.getClientRequestCount(requestType)).toBe(1);
      await expect
        .poll(() => gate.getClientRequestCount("creation.subscribe.request"))
        .toBeGreaterThan(0);
      expect(gate.getClientRequests(requestType).at(-1)).toEqual(firstMessage);
      expect(gate.getClientRequestCount("send_agent_message_request")).toBe(0);
      await expect(page.getByTestId("user-message").filter({ visible: true })).toHaveCount(1);
    },
  };
}

export async function hideCreationLifecycle(page: Page) {
  const frames = await loadSessionMessageReaders();
  let requests = 0;
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((frame) => {
      if (frames.client(frame)?.type === "workspace.create.request") requests++;
      server.send(frame);
    });
    server.onMessage((frame) => {
      const message = frames.server(frame);
      if (
        message?.type === "status" &&
        message.payload.status === "server_info" &&
        typeof message.payload.features === "object" &&
        message.payload.features !== null
      ) {
        browser.send(
          JSON.stringify({
            type: "session",
            message: {
              ...message,
              payload: {
                ...message.payload,
                features: { ...message.payload.features, creationLifecycle: false },
              },
            },
          }),
        );
        return;
      }
      browser.send(frame);
    });
  });
  return { expectNoCreationRequest: () => expect(requests).toBe(0) };
}

/** Simulate an uncertain receipt after the real daemon registered and ran the initial agent. */
export async function reportUnknownPromptOutcome(page: Page) {
  const frames = await loadSessionMessageReaders();
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((frame) => server.send(frame));
    server.onMessage((frame) => {
      const message = frames.server(frame);
      if (
        message?.type === "workspace.create.response" &&
        message.payload.agent &&
        message.payload.creation
      ) {
        const error = "Initial prompt outcome is uncertain for test";
        browser.send(
          JSON.stringify({
            ...JSON.parse(frame.toString()),
            message: {
              ...message,
              payload: {
                ...message.payload,
                error,
                creation: {
                  ...message.payload.creation,
                  phase: "failed",
                  error,
                  outcomeUnknown: true,
                },
              },
            },
          }),
        );
        return;
      }
      browser.send(frame);
    });
  });
}
