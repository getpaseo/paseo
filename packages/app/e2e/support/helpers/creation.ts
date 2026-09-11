import { expect, type Page } from "@playwright/test";
import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { daemonWsRoutePattern } from "./daemon-port";
import { gotoAppShell } from "./app";
import { gotoWorkspace } from "./launcher";
import { fillComposerDraft } from "./composer";
import { createAgentTabFromMenu } from "./workspace-tabs";
import { openNewWorkspaceComposer, selectWorkspaceIsolation } from "./new-workspace";
import { seedWorkspace } from "./seed-client";
import {
  waitForSidebarHydration,
  switchWorkspaceViaSidebar,
  workspaceDeckEntryLocator,
} from "./workspace-ui";
import { getServerId } from "./server-id";
import { WORKSPACE_DECK_MAX_MOUNTED_WORKSPACES } from "@/screens/workspace/workspace-deck-retention";
import type { installDaemonWebSocketGate } from "./daemon-websocket-gate";

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

export function observeCreationRequests(page: Page) {
  const pending = new Set<string>();
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const envelope = JSON.parse(payload.toString()) as { message?: SessionInboundMessage };
      const request = envelope.message;
      if (
        request?.type === "workspace.create.request" ||
        request?.type === "agent.create.request"
      ) {
        pending.add(request.requestId);
      }
    });
    socket.on("framereceived", ({ payload }) => {
      const envelope = JSON.parse(payload.toString()) as { message?: SessionOutboundMessage };
      const response = envelope.message;
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
    async settled() {
      await expect.poll(() => pending.size).toBe(0);
    },
  };
}

export async function retryNextAgentCreation(page: Page) {
  const retryIds = new Set<string>();
  const results: Array<{ status: string; agentId?: string }> = [];
  let repeated = false;
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((frame) => {
      const envelope = JSON.parse(frame.toString()) as { message?: SessionInboundMessage };
      const request = envelope.message;
      if (!repeated && request?.type === "agent.create.request") {
        repeated = true;
        for (let attempt = 1; attempt <= 3; attempt++) {
          const requestId = attempt === 1 ? request.requestId : `${request.requestId}-${attempt}`;
          retryIds.add(requestId);
          // Keep the app's operation key and payload; only RPC correlation changes.
          server.send(JSON.stringify({ ...envelope, message: { ...request, requestId } }));
        }
        return;
      }
      server.send(frame);
    });
    server.onMessage((frame) => {
      const envelope = JSON.parse(frame.toString()) as { message?: SessionOutboundMessage };
      const response = envelope.message;
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

export async function createCreationScenario(page: Page) {
  const requests = observeCreationRequests(page);
  const project = await seedWorkspace({ repoPrefix: "creation-idempotency-" });
  let workspaceId = project.workspaceId;
  return {
    cleanup: project.cleanup,
    async openWorkspaceForm(isolation: "local" | "worktree") {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, project);
      await selectWorkspaceIsolation(page, isolation);
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
    async expectPromptVisible(prompt?: string) {
      const rows = page.getByTestId("user-message");
      await expect(prompt ? rows.filter({ hasText: prompt }) : rows.first()).toBeVisible();
    },
    async expectWorkspaceReadyBeforeAgentCompletion() {
      await expect(page).toHaveURL(/\/workspace\//);
      await expect(page.getByTestId("user-message").first()).toBeVisible();
      await expect(
        page
          .locator('[data-testid^="workspace-tab-draft_"][aria-selected="true"]')
          .filter({ visible: true }),
      ).toBeVisible();
    },
    async expectOneCreatedWorkspace() {
      await expect(page).toHaveURL(/\/workspace\//);
      await requests.settled();
      const workspaces = (await project.client.fetchWorkspaces()).entries.filter(
        (workspace) =>
          workspace.projectId === project.projectId && workspace.id !== project.workspaceId,
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
      const draft = page
        .locator('[data-testid^="workspace-tab-draft_"][aria-selected="true"]')
        .filter({ visible: true })
        .first();
      const draftTestId = await draft.getAttribute("data-testid");
      expect(draftTestId).not.toBeNull();
      for (let index = 0; index < WORKSPACE_DECK_MAX_MOUNTED_WORKSPACES; index++) {
        const result = await project.client.createWorkspace({
          source: { kind: "directory", path: project.repoPath },
        });
        if (!result.workspace) throw new Error(result.error ?? "Failed to seed eviction workspace");
        await switchWorkspaceViaSidebar({
          page,
          serverId: getServerId(),
          workspaceId: result.workspace.id,
        });
      }
      await expect(workspaceDeckEntryLocator(page, getServerId(), workspaceId)).toHaveCount(0);
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
) {
  let firstMessage: ReturnType<typeof gate.getClientRequests>[number] | undefined;
  return {
    holdAcknowledgement() {
      gate.holdNextServerMessage("agent.create.response");
    },
    async waitForDeliveredPrompt() {
      await gate.waitForHeldServerMessage("agent.create.response");
      firstMessage = gate.getClientRequests("agent.create.request").at(-1);
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
      expect(gate.getClientRequestCount("agent.create.request")).toBe(1);
      await expect
        .poll(() => gate.getClientRequestCount("creation.subscribe.request"))
        .toBeGreaterThan(0);
      expect(gate.getClientRequests("agent.create.request").at(-1)).toEqual(firstMessage);
      expect(gate.getClientRequestCount("send_agent_message_request")).toBe(0);
      await expect(page.getByTestId("user-message").filter({ visible: true })).toHaveCount(1);
    },
  };
}
