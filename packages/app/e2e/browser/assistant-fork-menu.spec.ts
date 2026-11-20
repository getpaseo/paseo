import { expect, test as base, type Page } from "../support/fixtures";
import { awaitAssistantMessage } from "../support/helpers/agent-stream";
import {
  expectChatHistoryAttachment,
  expectInFlightForkAvailable,
  expectLiveAssistantText,
  forkInFlightTurnToNewTab,
  forkMostRecentAssistantTurnToNewTab,
  forkMostRecentAssistantTurnToNewWorkspace,
  observeForkAttachment,
} from "../support/helpers/assistant-fork";
import { composerLocator, expectComposerVisible, submitMessage } from "../support/helpers/composer";
import { daemonWsRoutePattern, getE2EDaemonPort } from "../support/helpers/daemon-port";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentOptions,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";
import { seedSavedSettingsHosts } from "../support/helpers/settings";
import { submitNewWorkspaceEmpty } from "../support/helpers/new-workspace";

const test = base.extend<{
  seedForkWorkspace: (options: MockAgentOptions) => Promise<MockAgentWorkspace>;
}>({
  seedForkWorkspace: async ({ browserName: _browserName }, provide) => {
    const sessions: MockAgentWorkspace[] = [];
    await provide(async (options) => {
      const session = await seedMockAgentWorkspace(options);
      sessions.push(session);
      return session;
    });
    await Promise.allSettled(sessions.map((session) => session.cleanup()));
  },
});

async function failTemplateLookupUntilRecovery(page: Page): Promise<() => void> {
  let failing = true;
  await page.routeWebSocket(daemonWsRoutePattern(), (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      if (typeof message !== "string") {
        server.send(message);
        return;
      }
      const envelope = JSON.parse(message) as {
        type?: string;
        agentId?: string;
        message?: { type?: string; agentId?: string };
      };
      const request = envelope.message ?? envelope;
      if (failing && request.type === "agent.template.get.request") {
        // Keep the real daemon's correlated failure, not a fabricated response.
        request.agentId = "missing-fork-template-source";
        server.send(JSON.stringify(envelope));
        return;
      }
      server.send(message);
    });
  });
  return () => {
    failing = false;
  };
}

test.describe("Assistant fork menu", () => {
  test.describe.configure({ timeout: 180_000 });

  test("awaits a fresh template before adding a fork draft or chat history attachment", async ({
    page,
    seedForkWorkspace,
  }) => {
    const gate = await installDaemonWebSocketGate(page);
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-fresh-template-",
      title: "Assistant fork fresh template",
      initialPrompt: "emit 1 coalesced agent stream updates for template freshness.",
      model: "ten-second-stream",
      modeId: "load-test",
    });
    await session.client.waitForFinish(session.agentId, 45_000);
    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    expect(gate.getClientRequests("hello")[0]).toMatchObject({
      type: "hello",
      capabilities: { agent_template_projection: true },
    });
    await awaitAssistantMessage(page);
    await composerLocator(page).fill("Keep this source draft while forking.");
    const sourceTab = page.getByTestId(`workspace-tab-agent_${session.agentId}`);
    await expect(sourceTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: "Select agent mode (Load test)" })).toBeVisible();
    const sourceUrl = page.url();

    gate.holdNextClientRequest("agent.template.get.request");
    await forkMostRecentAssistantTurnToNewTab(page);
    await gate.waitForHeldClientRequest();

    await expect(page).toHaveURL(sourceUrl);
    await expect(sourceTab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-testid^="workspace-tab-draft_"]')).toHaveCount(0);
    await expect(composerLocator(page)).toHaveValue("Keep this source draft while forking.");
    expect(gate.getClientRequestCount("agent.fork_context.request")).toBe(0);
    expect(await session.client.fetchAgent({ agentId: session.agentId })).toMatchObject({
      agent: { archivedAt: null },
    });

    // Change the daemon after the click captured its old app-side setup.
    await session.client.setAgentMode(session.agentId, "approval-test");
    gate.releaseHeldClientRequest();

    await expectChatHistoryAttachment(page);
    await expect(
      page.getByRole("button", { name: "Select agent mode (Approval test)" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Select model (Ten second stream)" }),
    ).toBeVisible();
    await expect(sourceTab).toHaveAttribute("aria-selected", "false");
    await sourceTab.click();
    await expect(composerLocator(page)).toHaveValue("Keep this source draft while forking.");
  });

  test("keeps the source tab and draft on template failure and can retry the workspace fork", async ({
    page,
    seedForkWorkspace,
  }) => {
    const allowRecovery = await failTemplateLookupUntilRecovery(page);
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-template-failure-",
      title: "Assistant fork template failure",
      initialPrompt: "emit 1 coalesced agent stream updates for template failure.",
      model: "ten-second-stream",
    });
    await session.client.waitForFinish(session.agentId, 45_000);
    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await composerLocator(page).fill("Do not lose this draft when the template fails.");
    const sourceTab = page.getByTestId(`workspace-tab-agent_${session.agentId}`);
    await expect(sourceTab).toHaveAttribute("aria-selected", "true");
    const sourceUrl = page.url();

    await forkMostRecentAssistantTurnToNewWorkspace(page);

    const error = page.getByText(/Agent not found: missing-fork-template-source/);
    await expect(error).toBeVisible();
    await expect(error).toContainText(/retry|try again/i);
    await expect(page).toHaveURL(sourceUrl);
    await expect(sourceTab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-testid^="workspace-tab-draft_"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open chat history attachment" })).toHaveCount(0);
    await expect(composerLocator(page)).toHaveValue(
      "Do not lose this draft when the template fails.",
    );
    await expect(composerLocator(page)).toBeEditable();
    expect(await session.client.fetchAgent({ agentId: session.agentId })).toMatchObject({
      agent: { archivedAt: null },
    });
    await expect(error).toBeVisible();

    allowRecovery();
    await forkMostRecentAssistantTurnToNewWorkspace(page);
    await expect(page).toHaveURL(/\/new\?.*draftId=/, { timeout: 30_000 });
    await expectChatHistoryAttachment(page);
  });

  test("forks a failed assistant turn that has no provider message id", async ({
    page,
    seedForkWorkspace,
  }) => {
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-failed-turn-",
      title: "Assistant fork failed turn",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await submitMessage(page, "Emit a synthetic turn failure.");
    await expect(page.getByText("[System Error] Requested mock provider failure")).toBeVisible({
      timeout: 30_000,
    });

    await forkMostRecentAssistantTurnToNewTab(page);
    await expectChatHistoryAttachment(page);
  });

  test("forks a streaming assistant turn without interrupting it", async ({
    page,
    seedForkWorkspace,
  }) => {
    const visibleBeforeFork = "where the auto-scroll logic actually lives";
    const visibleAfterFork = "the first useful step is to read the relevant files";
    const sourceAgentTitle = "Assistant fork in flight";
    const forkAttachment = observeForkAttachment(page);

    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-in-flight-",
      title: sourceAgentTitle,
      model: "thirty-minute-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await submitMessage(page, "Walk me through the scroll anchor behavior.");

    await expectInFlightForkAvailable(page);
    await expectLiveAssistantText(page, visibleBeforeFork);

    await forkInFlightTurnToNewTab(page);
    await expectChatHistoryAttachment(page);
    expect(await forkAttachment.waitForText()).toContain(visibleBeforeFork);
    await expect(page.getByRole("button", { name: "Menu backdrop", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: sourceAgentTitle }).click();
    await expectLiveAssistantText(page, visibleAfterFork);
  });

  test("focuses a forked assistant turn in a new workspace draft tab", async ({
    page,
    seedForkWorkspace,
  }) => {
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-focused-tab-",
      title: "Assistant fork focused tab",
      initialPrompt: "emit 1 coalesced agent stream updates for initial assistant fork turn.",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);

    await submitMessage(page, "emit 1 coalesced agent stream updates while this tab is visible.");
    await session.client.waitForFinish(session.agentId, 45_000);
    await awaitAssistantMessage(page);

    const agentTab = page.getByTestId(`workspace-tab-agent_${session.agentId}`);
    await expect(agentTab).toHaveAttribute("aria-selected", "true");

    await forkMostRecentAssistantTurnToNewTab(page);

    const selectedTab = page
      .getByTestId("workspace-tabs-row")
      .getByRole("button")
      .and(page.locator('[aria-selected="true"]'));
    await expect(selectedTab).toHaveAttribute("data-testid", /^workspace-tab-draft_/, {
      timeout: 30_000,
    });
    await expect(agentTab).toHaveAttribute("aria-selected", "false");
    await expectChatHistoryAttachment(page);
  });

  test("keeps the fork attachment after submitting an existing-workspace draft tab", async ({
    page,
    seedForkWorkspace,
  }) => {
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-tab-submit-",
      title: "Assistant fork tab submit",
      initialPrompt: "emit 1 coalesced agent stream updates for assistant fork tab submit.",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);

    await forkMostRecentAssistantTurnToNewTab(page);
    await expectChatHistoryAttachment(page);

    await submitMessage(page, "");

    const userMessage = page.getByTestId("user-message").filter({ hasText: "Chat history" }).last();
    await expect(userMessage).toBeVisible({ timeout: 30_000 });
    await expect(userMessage).not.toContainText("Source agent:");
  });

  test("forks an assistant turn into New Workspace and keeps the attachment across host changes", async ({
    page,
    seedForkWorkspace,
  }) => {
    await seedSavedSettingsHosts(page, [
      {
        serverId: getServerId(),
        label: "localhost",
        endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
      },
      {
        serverId: "secondary-assistant-fork-host",
        label: "Secondary host",
        // The host does not need to be reachable; this pins that the draft-scoped
        // attachment survives changing the selected target host.
        endpoint: "127.0.0.1:9",
      },
    ]);

    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-workspace-",
      title: "Assistant fork workspace",
      initialPrompt: "emit 1 coalesced agent stream updates for assistant fork new workspace.",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);

    await forkMostRecentAssistantTurnToNewWorkspace(page);

    await expect(page).toHaveURL(/\/new\?.*draftId=/, { timeout: 30_000 });
    await expectChatHistoryAttachment(page);

    await page.getByTestId("host-picker-trigger").click();
    await page
      .getByTestId("new-workspace-host-picker-option-secondary-assistant-fork-host")
      .click();
    await expectChatHistoryAttachment(page);
  });

  test("keeps the fork attachment after the new agent receives its user message", async ({
    page,
    seedForkWorkspace,
  }) => {
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-submit-",
      title: "Assistant fork submit",
      initialPrompt: "emit 1 coalesced agent stream updates for assistant fork submit.",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);

    await forkMostRecentAssistantTurnToNewWorkspace(page);
    await expectChatHistoryAttachment(page);

    await submitNewWorkspaceEmpty(page);

    const userMessage = page.getByTestId("user-message").filter({ hasText: "Chat history" }).last();
    await expect(userMessage).toBeVisible({ timeout: 30_000 });
    await expect(userMessage).not.toContainText("Source agent:");
  });
});
