import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { expect, test, type Page } from "../support/fixtures";
import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { gotoAppShell } from "../support/helpers/app";
import { gotoWorkspace } from "../support/helpers/launcher";
import { fillComposerDraft } from "../support/helpers/composer";
import { createAgentTabFromMenu } from "../support/helpers/workspace-tabs";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import {
  delayBrowserAgentCreatedStatus,
  openNewWorkspaceComposer,
  selectWorkspaceIsolation,
} from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

async function pressSubmitBeforeTheNextRender(page: Page, name: string): Promise<void> {
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

function observeCreationRequests(page: Page) {
  const pending = new Set<string>();
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const envelope = JSON.parse(payload.toString()) as { message?: SessionInboundMessage };
      const request = envelope.message;
      if (
        request?.type === "workspace.create.request" ||
        request?.type === "create_agent_request"
      ) {
        pending.add(request.requestId);
      }
    });
    socket.on("framereceived", ({ payload }) => {
      const envelope = JSON.parse(payload.toString()) as { message?: SessionOutboundMessage };
      const response = envelope.message;
      if (
        response?.type === "workspace.create.response" ||
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

async function retryNextAgentCreation(page: Page) {
  const retryIds = new Set<string>();
  const results: Array<{ status: string; agentId?: string }> = [];
  let repeated = false;
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((frame) => {
      const envelope = JSON.parse(frame.toString()) as { message?: SessionInboundMessage };
      const request = envelope.message;
      if (!repeated && request?.type === "create_agent_request") {
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
        response?.type === "status" &&
        (response.payload.status === "agent_created" ||
          response.payload.status === "agent_create_failed") &&
        typeof response.payload.requestId === "string" &&
        retryIds.delete(response.payload.requestId)
      ) {
        results.push(response.payload);
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

for (const isolation of ["local", "worktree"] as const) {
  test(`repeated Create clicks before a render create only one ${isolation} workspace`, async ({
    page,
  }) => {
    const requests = observeCreationRequests(page);
    const project = await seedWorkspace({ repoPrefix: "creation-idempotency-" });
    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, project);
      await selectWorkspaceIsolation(page, isolation);

      await pressSubmitBeforeTheNextRender(page, "Create");

      await expect(page).toHaveURL(/\/workspace\//);
      await requests.settled();
      const workspaces = await project.client.fetchWorkspaces();
      expect(
        workspaces.entries
          .filter(
            (workspace) =>
              workspace.projectId === project.projectId && workspace.id !== project.workspaceId,
          )
          .map((workspace) => workspace.id),
      ).toHaveLength(1);
    } finally {
      await project.cleanup();
    }
  });
}

test("repeated Send clicks before a render create only one agent", async ({ page }) => {
  const requests = observeCreationRequests(page);
  const project = await seedWorkspace({ repoPrefix: "agent-creation-idempotency-" });
  try {
    await gotoWorkspace(page, project.workspaceId);
    await createAgentTabFromMenu(page);
    await fillComposerDraft(page, "Start exactly one agent for this prompt.");

    await pressSubmitBeforeTheNextRender(page, "Send message");

    await expect(page.getByTestId("user-message").first()).toBeVisible();
    await requests.settled();
    const agents = await project.client.fetchAgents();
    expect(
      agents.entries
        .filter(({ agent }) => agent.workspaceId === project.workspaceId)
        .map(({ agent }) => agent.id),
    ).toHaveLength(1);
  } finally {
    await project.cleanup();
  }
});

test("retrying the app's agent creation returns the same agent for every attempt", async ({
  page,
}) => {
  const retries = await retryNextAgentCreation(page);
  const project = await seedWorkspace({ repoPrefix: "agent-creation-retries-" });
  try {
    await gotoWorkspace(page, project.workspaceId);
    await createAgentTabFromMenu(page);
    await fillComposerDraft(page, "Start exactly one agent for this prompt.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();

    const agentIds = await retries.completedAgentIds();

    expect(new Set(agentIds).size).toBe(1);
    const agents = await project.client.fetchAgents();
    expect(
      agents.entries.filter(({ agent }) => agent.workspaceId === project.workspaceId),
    ).toHaveLength(1);
  } finally {
    await project.cleanup();
  }
});

test("the first prompt still names an agent created with a receipt", async ({ page }) => {
  const project = await seedWorkspace({ repoPrefix: "creation-title-" });
  try {
    await gotoWorkspace(page, project.workspaceId);
    await createAgentTabFromMenu(page);
    await fillComposerDraft(page, "Name this new agent from its first prompt.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByTestId("user-message").first()).toBeVisible();
    await expect
      .poll(async () => {
        const agents = await project.client.fetchAgents();
        return agents.entries.find(({ agent }) => agent.workspaceId === project.workspaceId)?.agent
          .title;
      })
      .toBe("Name this new agent from its first prompt.");
  } finally {
    await project.cleanup();
  }
});

test("retrying after a lost first-prompt acknowledgement reuses the agent and message", async ({
  page,
}) => {
  const gate = await installDaemonWebSocketGate(page);
  const project = await seedWorkspace({ repoPrefix: "creation-lost-ack-" });
  try {
    await gotoWorkspace(page, project.workspaceId);
    await createAgentTabFromMenu(page);
    gate.holdNextServerMessage("send_agent_message_response");
    await fillComposerDraft(page, "Deliver this initial prompt once.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await gate.waitForHeldServerMessage("send_agent_message_response");
    const firstMessage = gate.getClientRequests("send_agent_message_request").at(-1);
    const agentFetches = gate.getClientRequestCount("fetch_agents_request");
    await gate.drop();
    gate.restore();
    await expect
      .poll(() => gate.getClientRequestCount("fetch_agents_request"))
      .toBeGreaterThan(agentFetches);
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
    await fillComposerDraft(page, "Deliver this initial prompt once.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => gate.getClientRequestCount("send_agent_message_request")).toBe(2);
    const secondMessage = gate.getClientRequests("send_agent_message_request").at(-1);
    expect(secondMessage).toMatchObject({
      agentId: firstMessage?.agentId,
      messageId: firstMessage?.messageId,
    });
    await expect(page.getByTestId("user-message")).toHaveCount(1);
    const agents = await project.client.fetchAgents();
    expect(
      agents.entries.filter(({ agent }) => agent.workspaceId === project.workspaceId),
    ).toHaveLength(1);
  } finally {
    gate.restore();
    await project.cleanup();
  }
});

test("repeated new-workspace prompt submissions create one workspace and one agent", async ({
  page,
}) => {
  const requests = observeCreationRequests(page);
  const project = await seedWorkspace({ repoPrefix: "creation-workspace-prompt-" });
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, project);
    await selectWorkspaceIsolation(page, "local");
    await fillComposerDraft(page, "Start one agent in one new workspace.");
    await pressSubmitBeforeTheNextRender(page, "Create");
    await expect(page).toHaveURL(/\/workspace\//);
    await expect(page.getByTestId("user-message").first()).toBeVisible();
    await requests.settled();
    const workspaces = (await project.client.fetchWorkspaces()).entries.filter(
      (workspace) =>
        workspace.projectId === project.projectId && workspace.id !== project.workspaceId,
    );
    expect(workspaces).toHaveLength(1);
    const agents = await project.client.fetchAgents();
    expect(
      agents.entries.filter(({ agent }) => agent.workspaceId === workspaces[0]!.id),
    ).toHaveLength(1);
  } finally {
    await project.cleanup();
  }
});

test("separate drafts can intentionally create two agents in the same workspace", async ({
  page,
}) => {
  const delayed = await delayBrowserAgentCreatedStatus(page);
  const project = await seedWorkspace({ repoPrefix: "creation-distinct-drafts-" });
  try {
    await gotoWorkspace(page, project.workspaceId);
    for (const prompt of ["Start the first agent.", "Start the second agent."]) {
      await createAgentTabFromMenu(page);
      await fillComposerDraft(page, prompt);
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await expect(page.getByTestId("user-message").filter({ hasText: prompt })).toBeVisible();
      await delayed.waitForDelayedCreatedStatus();
    }
    await expect
      .poll(
        async () =>
          (await project.client.fetchAgents()).entries.filter(
            ({ agent }) => agent.workspaceId === project.workspaceId,
          ).length,
      )
      .toBe(2);
    delayed.release();
  } finally {
    delayed.release();
    await project.cleanup();
  }
});
